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
  date_of_birth: Roi;
};

// Normalized ROIs (0..1) for CS Form No. 212 Revised 2018, page 1.
// These are conservative starter boxes for the Personal Information name rows.
// Same letter->legal remapping as 2025 (dy_norm=0.077). 2018 name row ~y=0.244.
export const PDS2018_PAGE1_ROIS: Page1Rois = {
  surname:       { x: 0.18, y: 0.224, w: 0.24, h: 0.040 },
  first_name:    { x: 0.43, y: 0.224, w: 0.21, h: 0.040 },
  middle_name:   { x: 0.72, y: 0.224, w: 0.12, h: 0.040 },
  date_of_birth: { x: 0.18, y: 0.272, w: 0.24, h: 0.040 },
};
