import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeAgeAndGroupFromDobIso } from "@/lib/age";
import { revalidatePath } from "next/cache";
import { canAccessReviewQueue } from "@/lib/auth/roles";

function normalizeNameForMatch(s: string) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikePlaceholderName(s: string) {
  const u = String(s || "").toUpperCase().trim();
  if (!u) return true;
  if (["N/A", "NA", "NONE", "NULL", "UNKNOWN", "NOT AVAILABLE"].includes(u)) return true;
  if (/\b(YYYY|MM|DD)\b/.test(u)) return true;
  if (/\bMM\s*DD\s*YYYY\b/.test(u)) return true;
  return false;
}

function looksLikeSamePersonLoose(a: any, b: any) {
  // Keep this simple and conservative: same normalized name key.
  const aKey = normalizeNameForMatch(`${a.last_name || ""} ${a.first_name || ""} ${a.middle_name || ""}`);
  const bKey = normalizeNameForMatch(`${b.last_name || ""} ${b.first_name || ""} ${b.middle_name || ""}`);
  if (!aKey || !bKey || aKey !== bKey) return false;

  // If both have DOB, require exact match. (Avoid fuzzy date guessing.)
  const aDob = a.date_of_birth ? String(a.date_of_birth) : "";
  const bDob = b.date_of_birth ? String(b.date_of_birth) : "";
  if (aDob && bDob) return aDob === bDob;

  // If either DOB missing, treat as possible match (manual confirmation required).
  return true;
}

export async function POST(request: Request) {
  try {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!canAccessReviewQueue(user)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400 });
  }

  const extractionId = String(body.extraction_id || "");
  const chosenEmployeeIdRaw = body.employee_id === null || body.employee_id === undefined ? null : String(body.employee_id);
  const forceCreateNew = Boolean(body.force_create_new);
  const confirm = body.confirm === null || body.confirm === undefined ? null : String(body.confirm);

  console.log("[DEBUG COMMIT] Request body:", body);

  if (!extractionId) return new NextResponse("Missing extraction_id", { status: 400 });

  const { data: extraction, error: exErr } = await supabase
    .from("extractions")
    .select("*")
    .eq("id", extractionId)
    .single();

  console.log("[DEBUG COMMIT] Extraction query result:", {
    found: !!extraction,
    error: exErr?.message || null,
    hasRawJson: !!extraction?.raw_extracted_json,
    hasAppointmentData: !!extraction?.appointment_data,
    appointmentDataKeys: extraction?.appointment_data ? Object.keys(extraction.appointment_data) : [],
  });

  if (exErr || !extraction?.document_id) {
    return new NextResponse(exErr?.message || "Extraction not found", { status: 404 });
  }

  const { data: doc, error: docErr } = await supabase
    .from("employee_documents")
    .select("id, employee_id")
    .eq("id", extraction.document_id)
    .single();

  console.log("[DEBUG COMMIT] Document query result:", {
    found: !!doc,
    error: docErr?.message || null,
    hasEmployeeId: !!doc?.employee_id,
  });

  if (docErr || !doc?.id) {
    return new NextResponse(docErr?.message || "Document not found", { status: 404 });
  }

  const rawJson = ((extraction as any)?.raw_extracted_json || {}) as any;
  const appointmentData = rawJson?.appointment_data || (extraction as any)?.appointment_data || {};
  const ownerFromRaw = rawJson?.owner_candidate || {};
  const ownerFromAppt = appointmentData?.owner || {};

  const ownerCandidate = {
    last_name: String(ownerFromRaw.last_name || ownerFromAppt.last_name || "").trim(),
    first_name: String(ownerFromRaw.first_name || ownerFromAppt.first_name || "").trim(),
    middle_name:
      ownerFromRaw.middle_name || ownerFromAppt.middle_name
        ? String(ownerFromRaw.middle_name || ownerFromAppt.middle_name || "").trim() || null
        : null,
    name_extension: ownerFromRaw.name_extension
      ? String(ownerFromRaw.name_extension).trim()
      : ownerFromAppt.name_extension
        ? String(ownerFromAppt.name_extension).trim()
        : null,
    date_of_birth:
      ownerFromRaw.date_of_birth || ownerFromAppt.date_of_birth
        ? String(ownerFromRaw.date_of_birth || ownerFromAppt.date_of_birth || "").trim() || null
        : null,
    gender: ownerFromRaw.gender
      ? String(ownerFromRaw.gender).trim()
      : ownerFromAppt.gender
        ? String(ownerFromAppt.gender).trim()
        : null,
  };

  if (!ownerCandidate.last_name || !ownerCandidate.first_name) {
    return new NextResponse("Owner candidate is missing last_name/first_name. Fix Owner fields first.", { status: 400 });
  }

  if (looksLikePlaceholderName(ownerCandidate.last_name) || looksLikePlaceholderName(ownerCandidate.first_name)) {
    return new NextResponse("Owner candidate looks invalid (placeholder name). Re-run OCR with a clearer scan.", {
      status: 400,
    });
  }

  const alreadyLinked = doc.employee_id ? String(doc.employee_id) : null;
  const primaryEmployeeId = alreadyLinked || null;

  const patchCommittedExtraction = (employeeId: string) =>
    ({
      status: "committed" as const,
      raw_extracted_json: {
        ...(extraction as any).raw_extracted_json,
        owner_employee_id: employeeId,
      },
      linked_employee_id: employeeId,
      updated_by: user.id,
    }) as Record<string, unknown>;

  // Helper: Link ALL documents in the same document_set/batch to the employee
  const linkAllDocs = async (employeeId: string) => {
    const setId = (extraction as any)?.document_set_id as string | null | undefined;
    const batchId = (extraction as any)?.batch_id as string | null | undefined;

    // Always link the anchor document for this extraction (commit must not rely on sibling query alone).
    const { error: anchorDocErr } = await supabase
      .from("employee_documents")
      .update({ employee_id: employeeId })
      .eq("id", doc.id);

    if (anchorDocErr) {
      console.error("[COMMIT] link anchor employee_document failed:", anchorDocErr);
      throw new Error(anchorDocErr.message || "Failed to link document to employee");
    }

    const siblingOr: string[] = [];
    if (setId) siblingOr.push(`document_set_id.eq.${setId}`);
    if (batchId) siblingOr.push(`batch_id.eq.${batchId}`);

    if (siblingOr.length === 0) {
      const { error: loneExErr } = await supabase
        .from("extractions")
        .update({ linked_employee_id: employeeId } as any)
        .eq("id", extractionId);
      if (loneExErr) console.error("[COMMIT] linked_employee_id update failed:", loneExErr);
      return;
    }

    // Siblings: same document set OR same batch (AND was too strict when one FK is null or IDs differ).
    const { data: relatedDocs, error: sibErr } = await supabase
      .from("employee_documents")
      .select("id")
      .is("employee_id", null)
      .neq("id", doc.id)
      .or(siblingOr.join(","));

    if (sibErr) {
      console.error("[COMMIT] sibling documents query failed:", sibErr);
    } else {
      const sibIds = (relatedDocs || []).map((d: any) => d.id).filter(Boolean);
      if (sibIds.length > 0) {
        const { error: sibUpErr } = await supabase
          .from("employee_documents")
          .update({ employee_id: employeeId })
          .in("id", sibIds);
        if (sibUpErr) console.error("[COMMIT] link sibling documents failed:", sibUpErr);
      }
    }

    try {
      const { data: relatedEx, error: exQErr } = await supabase.from("extractions").select("id").or(siblingOr.join(","));
      if (exQErr) {
        console.error("[COMMIT] related extractions query failed:", exQErr);
      } else {
        const exIds = [...new Set([...(relatedEx || []).map((e: any) => e.id), extractionId])].filter(Boolean);
        if (exIds.length > 0) {
          const { error: exUpErr } = await supabase
            .from("extractions")
            .update({ linked_employee_id: employeeId } as any)
            .in("id", exIds);
          if (exUpErr) console.error("[COMMIT] link related extractions failed:", exUpErr);
        }
      }
    } catch (e) {
      console.error("[COMMIT] related extractions update:", e);
    }
  };

  // Helper: Save appointment fields to employee record
  const saveAppointmentFields = async (employeeId: string) => {
    const rawJson = (extraction as any)?.raw_extracted_json;
    const appointmentData = rawJson?.appointment_data || (extraction as any)?.appointment_data;
    
    console.log("[DEBUG] saveAppointmentFields called for employee:", employeeId);
    console.log("[DEBUG] appointment_data found:", !!appointmentData);
    console.log("[DEBUG] appointment_data content:", JSON.stringify(appointmentData, null, 2));
    
    if (!appointmentData) {
      console.log("[DEBUG] No appointment data found - skipping");
      return;
    }

    const patch: any = {};
    
    // Appointment fields should overwrite existing values (appointment is authoritative)
    if (appointmentData.position_title) patch.position_title = appointmentData.position_title;
    if (appointmentData.office_department) patch.office_department = appointmentData.office_department;
    if (appointmentData.sg) patch.sg = appointmentData.sg;
    if (appointmentData.step) patch.step = appointmentData.step;
    if (appointmentData.monthly_salary) patch.monthly_salary = appointmentData.monthly_salary;
    if (appointmentData.annual_salary) patch.annual_salary = appointmentData.annual_salary;
    
    if (appointmentData.appointment_date) {
      patch.date_hired = appointmentData.appointment_date;
      const hireDate = new Date(appointmentData.appointment_date);
      const now = new Date();
      const diffMs = now.getTime() - hireDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      patch.tenure_years = Math.floor(diffDays / 365);
      patch.tenure_months = Math.floor((diffDays % 365) / 30);
    }

    console.log("[DEBUG] Patch to apply:", JSON.stringify(patch, null, 2));

    if (Object.keys(patch).length > 0) {
      patch.updated_by = user.id;
      // Appointment data updates the employee record directly
      const { error: updateError, data: updateData } = await supabase.from("employees").update(patch).eq("id", employeeId).select();
      if (updateError) {
        console.error("[DEBUG] Failed to update employee:", updateError);
        console.error("[DEBUG] Error code:", updateError.code);
        console.error("[DEBUG] Error message:", updateError.message);
      } else {
        console.log("[DEBUG] Employee updated successfully");
        console.log("[DEBUG] Update result:", updateData);
        
        // Verify the update by re-querying
        const { data: verifyData } = await supabase.from("employees").select("position_title, office_department, sg, step, monthly_salary").eq("id", employeeId).single();
        console.log("[DEBUG] Verified employee data after update:", verifyData);
      }
    }
  };

  // 1) If UI selected an employee explicitly, link to it.
  if (chosenEmployeeIdRaw) {
    const chosenEmployeeId = chosenEmployeeIdRaw;

    await linkAllDocs(chosenEmployeeId);
    await saveAppointmentFields(chosenEmployeeId);

    // Mark committed.
    await supabase.from("extractions").update(patchCommittedExtraction(chosenEmployeeId)).eq("id", extractionId);

    try {
      revalidatePath("/masterlist");
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, employee_id: chosenEmployeeId, action: "linked" });
  }

  // 2) If already linked (doc.employee_id), treat that as the primary key.
  if (primaryEmployeeId) {
    // Update appointment fields first
    await saveAppointmentFields(primaryEmployeeId);
    
    // Consider updating missing demographics, but don't overwrite.
    const dobIso = ownerCandidate.date_of_birth || null;
    const computedAge = dobIso ? computeAgeAndGroupFromDobIso(dobIso) : { age: null, age_group: null };

    const patch: any = {};
    if (dobIso) patch.date_of_birth = dobIso;
    if (ownerCandidate.gender) patch.gender = ownerCandidate.gender;
    if (computedAge.age !== null) {
      patch.age = computedAge.age;
      patch.age_group = computedAge.age_group;
    }

    // Best-effort: update only null-ish fields.
    const { data: existing } = await supabase
      .from("employees")
      .select("id, date_of_birth, gender, age, age_group")
      .eq("id", primaryEmployeeId)
      .single();

    if (existing) {
      const safePatch: any = {};
      if (patch.date_of_birth && !existing.date_of_birth) safePatch.date_of_birth = patch.date_of_birth;
      if (patch.gender && !existing.gender) safePatch.gender = patch.gender;
      if (patch.age !== null && (existing.age === null || existing.age === undefined || Number(existing.age) === 0)) {
        safePatch.age = patch.age;
        safePatch.age_group = patch.age_group;
      }
      if (Object.keys(safePatch).length > 0) {
        safePatch.updated_by = user.id;
        await supabase.from("employees").update(safePatch).eq("id", primaryEmployeeId);
      }
    }

    await supabase.from("extractions").update(patchCommittedExtraction(primaryEmployeeId)).eq("id", extractionId);

    try {
      revalidatePath("/masterlist");
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, employee_id: primaryEmployeeId, action: "already_linked" });
  }

  // 3) No link yet: find candidates.
  const last = ownerCandidate.last_name;
  const first = ownerCandidate.first_name;

  const { data: candidates, error: candErr } = await supabase
    .from("employees")
    .select("id, last_name, first_name, middle_name, date_of_birth")
    .ilike("last_name", last)
    .ilike("first_name", first)
    .limit(25);

  if (candErr) return new NextResponse(candErr.message, { status: 400 });

  // Match based on last_name and first_name only (middle name can differ due to OCR variations)
  const normKey = normalizeNameForMatch(`${last} ${first}`);

  const possible = (candidates || []).filter((c: any) => {
    const cKey = normalizeNameForMatch(`${c.last_name || ""} ${c.first_name || ""}`);
    if (cKey !== normKey) return false;
    // Also check if middle names are compatible (one could be initial of the other)
    const ownerMiddle = String(ownerCandidate.middle_name || "").toUpperCase().trim();
    const candMiddle = String(c.middle_name || "").toUpperCase().trim();
    if (ownerMiddle && candMiddle) {
      // If middle names are different, check if one is an initial of the other
      // e.g., "N" vs "Napoles" or "N." vs "Napoles"
      const ownerInitial = ownerMiddle.charAt(0);
      const candInitial = candMiddle.charAt(0);
      // Allow match if initials match or one contains the other
      if (ownerInitial !== candInitial && !ownerMiddle.includes(candMiddle) && !candMiddle.includes(ownerMiddle)) {
        return false;
      }
    }
    return looksLikeSamePersonLoose(ownerCandidate, c);
  });

  const dobIso = ownerCandidate.date_of_birth || null;

  // Auto-link if we have DOB and exactly one candidate matches name+DOB.
  if (dobIso) {
    const exact = possible.filter((c: any) => String(c.date_of_birth || "") === dobIso);
    if (exact.length === 1 && !forceCreateNew && confirm !== "no") {
      const targetId = String(exact[0].id);
      await linkAllDocs(targetId);
      await saveAppointmentFields(targetId);

      await supabase.from("extractions").update(patchCommittedExtraction(targetId)).eq("id", extractionId);

      try {
        revalidatePath("/masterlist");
      } catch {
        // ignore
      }

      return NextResponse.json({ ok: true, employee_id: targetId, action: "auto_linked" });
    }
  }

  // One plausible name match but owner has no DOB: require explicit confirmation (UI sends employee_id).
  if (!dobIso && possible.length === 1 && !forceCreateNew) {
    const c = possible[0];
    return NextResponse.json({
      needs_confirmation: true,
      reason: "dob_missing",
      candidates: [
        {
          id: String(c.id),
          last_name: c.last_name,
          first_name: c.first_name,
          middle_name: c.middle_name ?? null,
          date_of_birth: c.date_of_birth ?? null,
        },
      ],
    });
  }

  const docTypeFinal = String((extraction as any).doc_type_final || "").toLowerCase();
  const isAppointment = docTypeFinal === "appointment";

  // Explicit new record (even when similar names exist): user chose from confirmation UI.
  if (forceCreateNew && !isAppointment) {
    const dobForAge = ownerCandidate.date_of_birth || null;
    const computedAge = dobForAge ? computeAgeAndGroupFromDobIso(dobForAge) : { age: null as number | null, age_group: null as string | null };

    const { data: inserted, error: insertErr } = await supabase
      .from("employees")
      .insert({
        last_name: ownerCandidate.last_name,
        first_name: ownerCandidate.first_name,
        middle_name: ownerCandidate.middle_name || null,
        name_extension: ownerCandidate.name_extension || null,
        date_of_birth: dobForAge,
        gender: ownerCandidate.gender || null,
        age: computedAge.age,
        age_group: computedAge.age_group,
        created_by: user.id,
        updated_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr || !inserted?.id) {
      console.error("[COMMIT] insert employee (force new) failed:", insertErr);
      return new NextResponse(insertErr?.message || "Failed to create employee record", { status: 400 });
    }

    const newId = String(inserted.id);
    await linkAllDocs(newId);
    await saveAppointmentFields(newId);

    await supabase.from("extractions").update(patchCommittedExtraction(newId)).eq("id", extractionId);

    try {
      revalidatePath("/masterlist");
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, employee_id: newId, action: "created_new_forced" });
  }

  // Several plausible matches: ask HR to pick one (UI sends employee_id on retry).
  if (possible.length > 1 && !forceCreateNew) {
    return NextResponse.json({
      needs_confirmation: true,
      reason: "multiple_matches",
      candidates: possible.map((c: any) => ({
        id: String(c.id),
        last_name: c.last_name,
        first_name: c.first_name,
        middle_name: c.middle_name ?? null,
        date_of_birth: c.date_of_birth ?? null,
      })),
    });
  }

  // Single existing match → link (safe default).
  if (possible.length === 1 && !forceCreateNew) {
    const targetId = String(possible[0].id);

    await linkAllDocs(targetId);
    await saveAppointmentFields(targetId);

    await supabase.from("extractions").update(patchCommittedExtraction(targetId)).eq("id", extractionId);

    try {
      revalidatePath("/masterlist");
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, employee_id: targetId, action: "linked_existing" });
  }

  // No matches: appointments cannot invent net-new employees from this flow.
  if (isAppointment) {
    return new NextResponse(
      "No matching employee found. Appointment documents update existing masterlist rows—upload and commit a PDS first, search for the employee above, or confirm duplicate handling.",
      { status: 400 }
    );
  }

  // No matches (PDS / other): create the employee row so Masterlist is populated.
  {
    const dobForAge = ownerCandidate.date_of_birth || null;
    const computedAge = dobForAge ? computeAgeAndGroupFromDobIso(dobForAge) : { age: null as number | null, age_group: null as string | null };

    const { data: inserted, error: insertErr } = await supabase
      .from("employees")
      .insert({
        last_name: ownerCandidate.last_name,
        first_name: ownerCandidate.first_name,
        middle_name: ownerCandidate.middle_name || null,
        name_extension: ownerCandidate.name_extension || null,
        date_of_birth: dobForAge,
        gender: ownerCandidate.gender || null,
        age: computedAge.age,
        age_group: computedAge.age_group,
        created_by: user.id,
        updated_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr || !inserted?.id) {
      console.error("[COMMIT] insert employee failed:", insertErr);
      return new NextResponse(insertErr?.message || "Failed to create employee record", { status: 400 });
    }

    const newId = String(inserted.id);
    await linkAllDocs(newId);
    await saveAppointmentFields(newId);

    await supabase.from("extractions").update(patchCommittedExtraction(newId)).eq("id", extractionId);

    try {
      revalidatePath("/masterlist");
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, employee_id: newId, action: "created" });
  }
  } catch (e) {
    console.error("[COMMIT] failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(msg || "Commit failed", { status: 400 });
  }
}
