import Image from "next/image";

/** Source: `files/pinamungajan logo.png` on white bg */
const LOGO_SRC = "/pinamungajan-logo.png";
const LOGO_W = 288;
const LOGO_H = 287;

type BrandLogoVariant = "header" | "hero" | "floating";

const variantClass: Record<BrandLogoVariant, string> = {
  /** Beside title in app header — crisp on retina, aligned left */
  header:
    "h-10 w-auto min-h-[2.5rem] max-w-[168px] object-contain object-left sm:h-11 sm:max-w-[184px]",
  /** Login and marketing-style hero */
  hero: "mx-auto h-[4.75rem] w-auto max-w-[min(92vw,17.5rem)] object-contain object-center sm:h-[7.25rem] sm:max-w-[20rem]",
  /** Help FAB — square inset inside circular button */
  floating: "h-[2.75rem] w-[2.75rem] object-contain object-center",
};

/**
 * Official LGU logo (`public/pinamungajan-logo.png`).
 * Replace that file if branding updates (keep the same path or update `LOGO_SRC`).
 */
export function BrandLogo({
  variant,
  className = "",
  priority = false,
}: {
  variant: BrandLogoVariant;
  className?: string;
  /** Set on LCP images (header, login) */
  priority?: boolean;
}) {
  return (
    <Image
      src={LOGO_SRC}
      alt="LGU Pinamungajan"
      width={LOGO_W}
      height={LOGO_H}
      sizes={variant === "hero" ? "(max-width: 640px) 70vw, 280px" : variant === "header" ? "184px" : "44px"}
      priority={priority}
      className={`${variantClass[variant]} ${className}`.trim()}
    />
  );
}
