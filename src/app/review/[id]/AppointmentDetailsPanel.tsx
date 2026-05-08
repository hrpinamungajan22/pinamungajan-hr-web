"use client";

import { useEffect, useMemo, useState } from "react";
import { CommitEmployeePanel } from "@/app/review/[id]/CommitEmployeePanel";

type AppointmentOwner = {
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  date_of_birth?: string | null;
};

type AppointmentData = {
  owner?: AppointmentOwner | null;
  position_title?: string | null;
  office_department?: string | null;
  sg?: number | null;
  step?: number | null;
  monthly_salary?: number | null;
  annual_salary?: number | null;
  appointment_date?: string | null;
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

function numberInputValue(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "" : String(value);
}

function formatPesoInputValue(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatPesoTextValue(value: string) {
  const parsed = parseNullableMoney(value);
  return parsed === null ? value : formatPesoInputValue(parsed);
}

function parseNullableInteger(value: string, min: number, max: number) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseNullableMoney(value: string) {
  const trimmed = String(value || "")
    .trim()
    .replace(/[₱]/g, "")
    .replace(/PHP/gi, "")
    .replace(/,/g, "");
  if (!trimmed) return null;
  const parsed = parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function AppointmentDetailsPanel({
  extractionId,
  initialLinkedEmployeeId,
  initialAppointmentData,
}: {
  extractionId: string;
  initialLinkedEmployeeId: string | null;
  initialAppointmentData: AppointmentData | null;
}) {
  const [ownerLastName, setOwnerLastName] = useState(String(initialAppointmentData?.owner?.last_name || ""));
  const [ownerFirstName, setOwnerFirstName] = useState(String(initialAppointmentData?.owner?.first_name || ""));
  const [ownerMiddleName, setOwnerMiddleName] = useState(String(initialAppointmentData?.owner?.middle_name || ""));
  const [positionTitle, setPositionTitle] = useState(String(initialAppointmentData?.position_title || ""));
  const [officeDepartment, setOfficeDepartment] = useState(String(initialAppointmentData?.office_department || ""));
  const [sg, setSg] = useState(numberInputValue(initialAppointmentData?.sg ?? null));
  const [step, setStep] = useState(numberInputValue(initialAppointmentData?.step ?? null));
  const [monthlySalary, setMonthlySalary] = useState(formatPesoInputValue(initialAppointmentData?.monthly_salary ?? null));
  const [annualSalary, setAnnualSalary] = useState(formatPesoInputValue(initialAppointmentData?.annual_salary ?? null));
  const [appointmentDate, setAppointmentDate] = useState(String(initialAppointmentData?.appointment_date || ""));

  useEffect(() => {
    setOwnerLastName(String(initialAppointmentData?.owner?.last_name || ""));
    setOwnerFirstName(String(initialAppointmentData?.owner?.first_name || ""));
    setOwnerMiddleName(String(initialAppointmentData?.owner?.middle_name || ""));
    setPositionTitle(String(initialAppointmentData?.position_title || ""));
    setOfficeDepartment(String(initialAppointmentData?.office_department || ""));
    setSg(numberInputValue(initialAppointmentData?.sg ?? null));
    setStep(numberInputValue(initialAppointmentData?.step ?? null));
    setMonthlySalary(formatPesoInputValue(initialAppointmentData?.monthly_salary ?? null));
    setAnnualSalary(formatPesoInputValue(initialAppointmentData?.annual_salary ?? null));
    setAppointmentDate(String(initialAppointmentData?.appointment_date || ""));
  }, [
    initialAppointmentData?.owner?.last_name,
    initialAppointmentData?.owner?.first_name,
    initialAppointmentData?.owner?.middle_name,
    initialAppointmentData?.position_title,
    initialAppointmentData?.office_department,
    initialAppointmentData?.sg,
    initialAppointmentData?.step,
    initialAppointmentData?.monthly_salary,
    initialAppointmentData?.annual_salary,
    initialAppointmentData?.appointment_date,
  ]);

  function applySelectedEmployee(employee: SelectedEmployee) {
    setOwnerLastName(String(employee.last_name || ""));
    setOwnerFirstName(String(employee.first_name || ""));
    setOwnerMiddleName(String(employee.middle_name || ""));
  }

  const owner = useMemo(
    () => ({
      last_name: trimNullable(ownerLastName),
      first_name: trimNullable(ownerFirstName),
      middle_name: trimNullable(ownerMiddleName),
      date_of_birth: null,
    }),
    [ownerFirstName, ownerLastName, ownerMiddleName]
  );

  const appointmentData = useMemo(
    () => ({
      owner,
      position_title: trimNullable(positionTitle),
      office_department: trimNullable(officeDepartment),
      sg: parseNullableInteger(sg, 1, 33),
      step: parseNullableInteger(step, 1, 8),
      monthly_salary: parseNullableMoney(monthlySalary),
      annual_salary: parseNullableMoney(annualSalary),
      appointment_date: trimNullable(appointmentDate),
    }),
    [annualSalary, appointmentDate, monthlySalary, officeDepartment, owner, positionTitle, sg, step]
  );

  const inputClass = "app-input mt-1 min-h-9 py-1.5 text-sm";

  return (
    <div className="app-card p-4">
      <div className="text-sm font-semibold text-app-text">Appointment Details</div>
      <div className="mt-2 text-xs text-app-muted">
        Review and correct the extracted appointment fields before saving them to the masterlist.
      </div>
      <div className="mt-3 rounded-lg bg-app-surface-muted px-3 py-3 ring-1 ring-app-border/45">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Last Name</div>
            <input value={ownerLastName} onChange={(e) => setOwnerLastName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">First Name</div>
            <input value={ownerFirstName} onChange={(e) => setOwnerFirstName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Middle Name</div>
            <input value={ownerMiddleName} onChange={(e) => setOwnerMiddleName(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Position Title</div>
            <input value={positionTitle} onChange={(e) => setPositionTitle(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2 lg:col-span-2">
            <div className="text-[11px] font-semibold text-app-text">Office / Department</div>
            <input value={officeDepartment} onChange={(e) => setOfficeDepartment(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Salary Grade (SG)</div>
            <input value={sg} onChange={(e) => setSg(e.target.value)} className={inputClass} inputMode="numeric" />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Step</div>
            <input value={step} onChange={(e) => setStep(e.target.value)} className={inputClass} inputMode="numeric" />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Date of Signing</div>
            <input type="date" value={appointmentDate} onChange={(e) => setAppointmentDate(e.target.value)} className={inputClass} />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Monthly Salary</div>
            <input
              value={monthlySalary}
              onChange={(e) => setMonthlySalary(e.target.value)}
              onBlur={(e) => setMonthlySalary(formatPesoTextValue(e.target.value))}
              className={inputClass}
              inputMode="decimal"
              placeholder="₱0.00"
            />
          </div>
          <div className="rounded-md border border-app-border bg-app-surface px-2 py-2">
            <div className="text-[11px] font-semibold text-app-text">Annual Salary</div>
            <input
              value={annualSalary}
              onChange={(e) => setAnnualSalary(e.target.value)}
              onBlur={(e) => setAnnualSalary(formatPesoTextValue(e.target.value))}
              className={inputClass}
              inputMode="decimal"
              placeholder="₱0.00"
            />
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-app-primary/25 bg-app-primary/5 px-3 py-3">
        <div className="text-xs font-semibold text-app-text">Confirm & Save to Masterlist</div>
        <div className="mt-1 text-[11px] text-app-muted">
          The selected employee will be linked automatically when the owner matches exactly, and the edited appointment fields will be saved to the masterlist.
        </div>
        <div className="mt-2">
          <CommitEmployeePanel
            extractionId={extractionId}
            initialLinkedEmployeeId={initialLinkedEmployeeId}
            owner={owner}
            appointmentData={appointmentData}
            onEmployeeSelected={applySelectedEmployee}
          />
        </div>
      </div>
    </div>
  );
}
