export type Roi = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Page1Rois = {
  surname: Roi;
  first_name: Roi;
  middle_name: Roi;
  name_extension: Roi;
  date_of_birth: Roi;
};

// Normalized ROIs (0..1) for CS Form No. 212 Revised 2025, page 1.
// These values are intentionally conservative and should be refined using the official template PDF render.
// They are designed to isolate the Personal Information name rows and avoid instruction/header text.
// Coordinates derived from CS Form 212-2025 (letter, 8.5x11) remapped to legal (8.5x13)
// via normalizeScanToLegal contain-fit: dy_norm=0.077 offset, scale=1.0, dx=0.
// Name row (all 3 fields on SAME Y): y = 0.195*11/13 + 0.077 = 0.242
// Layout: SURNAME | FIRST NAME | MIDDLE NAME are HORIZONTAL COLUMNS on row y≈0.242
export const PDS2025_PAGE1_ROIS: Page1Rois = {
  surname:        { x: 0.18, y: 0.222, w: 0.24, h: 0.040 },
  first_name:     { x: 0.43, y: 0.222, w: 0.21, h: 0.040 },
  middle_name:    { x: 0.74, y: 0.222, w: 0.10, h: 0.040 },
  name_extension: { x: 0.85, y: 0.222, w: 0.10, h: 0.040 },
  date_of_birth:  { x: 0.18, y: 0.270, w: 0.24, h: 0.040 },
};
