/**
 * Light or dark, or whatever the machine is set to.
 *
 * Following the system is the default and stays the default, because that is
 * the setting almost everyone actually wants and a page that ignores it is a
 * page that glares at two in the morning. What this adds is the override, for
 * reading one way while the machine is set the other.
 *
 * Three states rather than two, because a plain toggle has no way back to
 * following along: whichever way it was flipped, it is then stuck being told.
 */

import { useCallback, useEffect, useState } from "react";
import { remembered, remember } from "../remembered.ts";

const THEMES = [
  { as: "auto", mark: "◐", says: "following the system" },
  { as: "light", mark: "☀", says: "light" },
  { as: "dark", mark: "☾", says: "dark" },
] as const;

export type ThemeName = (typeof THEMES)[number]["as"];

function named(what: string | undefined) {
  return THEMES.find((theme) => theme.as === what) ?? THEMES[0];
}

export function useTheme() {
  const [name, setName] = useState<ThemeName>(
    () => named(remembered().theme).as,
  );

  useEffect(() => {
    // Absent means follow along, which is what the stylesheet reads.
    if (name === "auto") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = name;
    remember({ theme: name });
  }, [name]);

  const cycle = useCallback(() => {
    setName(
      (was) =>
        THEMES[
          (THEMES.findIndex((theme) => theme.as === was) + 1) % THEMES.length
        ]?.as ?? "auto",
    );
  }, []);

  const now = named(name);
  const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]?.as ?? "auto";

  return [{ ...now, next }, cycle] as const;
}
