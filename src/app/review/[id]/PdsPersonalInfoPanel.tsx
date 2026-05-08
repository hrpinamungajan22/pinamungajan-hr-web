"use client";

import { useMemo, useState } from "react";
import { CommitEmployeePanel } from "@/app/review/[id]/CommitEmployeePanel";

type PdsPersonalData = {
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  displayFromDebugOnly?: boolean;
};

type SelectedEmployee = {
  id: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  date_of_birth: string | null;
};

function trimNullable(value: string) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function normalizeDateInputValue(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

export function PdsPersonalInfoPanel({
  extractionId,
  initialLinkedEmployeeId,
  initialPersonalData,
}: {
  extractionId: string;
  initialLinkedEmployeeId: string | null;
  initialPersonalData: PdsPersonalData | null;
}) {
  const [lastName, setLastName] = useState(String(initialPersonalData?.last_name || ""));
  const [firstName, setFirstName] = useState(String(initialPersonalData?.first_name || ""));
  const [middleName, setMiddleName] = useState(String(initialPersonalData?.middle_name || ""));
  const [dateOfBirth, setDateOfBirth] = useState(normalizeDateInputValue(initialPersonalData?.date_of_birth));
  const [gender, setGender] = useState(String(initialPersonalData?.gender || ""));

  function applySelectedEmployee(employee: SelectedEmployee) {
    setLastName(String(employee.last_name || ""));
    setFirstName(String(employee.first_name || ""));
    setMiddleName(String(employee.middle_name || ""));
    setDateOfBirth(normalizeDateInputValue(employee.date_of_birth));
  }

  const owner = useMemo(
    () => ({
      last_name: trimNullable(lastName),
      first_name: trimNullable(firstName),
      middle_name: trimNullable(middleName),
      date_of_birth: trimNullable(dateOfBirth),
      gender: trimNullable(gender),
    }),
    [dateOfBirth, firstName, gender, lastName, middleName]
  );

  const inputClass = "app-input mt-1 min-h-9 py-1.5 text-sm";

  return (
    <div className="app-card p-4">
      <div className="text-sm font-semibold text-app-text">Personal Information (PDS)</div>
      <div className="mt-2 text-xs text-app-muted">
        Review and correct the extracted PDS personal details before saving them to the masterlist.
      </div>
      {initialPersonalData?.displayFromDebugOnly ? (
        <div className="app-alert-warning mt-2 text-[11px] leading-relaxed">
          Names below include OCR anchor lines that were not stored as <strong className="text-app-text">owner_candidate</strong> yet.
          You can fix the fields here before saving to Masterlist.
        </div>
      ) : null}
      <div className="mt-3 rounded-lg bg-app-surface-muted px-3 py-3 ring-1 ring-app-border/45">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Last name</div>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">First name</div>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Middle name</div>
            <input value={middleName} onChange={(e) => setMiddleName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Date of birth</div>
            <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2 sm:col-span-2 lg:col-span-1">
            <div className="text-[11px] font-semibold text-app-text">Sex at birth</div>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputClass}>
              <option value="">Select sex at birth</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-app-primary/25 bg-app-primary/5 px-3 py-3">
        <div className="text-xs font-semibold text-app-text">Confirm & Save to Masterlist</div>
        <div className="mt-1 text-[11px] text-app-muted">
          The corrected PDS personal details below will be used for linking, creating, and saving the employee record.
        </div>
        <div className="mt-2">
          <CommitEmployeePanel
            extractionId={extractionId}
            initialLinkedEmployeeId={initialLinkedEmployeeId}
            owner={owner}
            onEmployeeSelected={applySelectedEmployee}
          />
        </div>
      </div>
    </div>
  );
}
