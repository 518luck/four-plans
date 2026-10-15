import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { IconHandle } from "@animateicons/react";
import { ArrowRightIcon } from "@animateicons/react/lucide/arrow-right-icon";
import { BookOpenIcon } from "@animateicons/react/lucide/book-open-icon";
import { ClockIcon } from "@animateicons/react/lucide/clock-icon";
import { ChartColumnIncreasingIcon } from "@animateicons/react/lucide/chart-column-increasing-icon";
import { DownloadIcon } from "@animateicons/react/lucide/download-icon";
import { ExpandIcon } from "@animateicons/react/lucide/expand-icon";
import { FlagIcon } from "@animateicons/react/lucide/flag-icon";
import { LayoutGridIcon } from "@animateicons/react/lucide/layout-grid-icon";
import { MoonIcon } from "@animateicons/react/lucide/moon-icon";
import { PencilIcon } from "@animateicons/react/lucide/pencil-icon";
import { PlusIcon } from "@animateicons/react/lucide/plus-icon";
import { RotateCcwIcon } from "@animateicons/react/lucide/rotate-ccw-icon";
import { ScanIcon } from "@animateicons/react/lucide/scan-icon";
import { ShrinkIcon } from "@animateicons/react/lucide/shrink-icon";
import { SunIcon } from "@animateicons/react/lucide/sun-icon";
import { TargetIcon } from "@animateicons/react/lucide/target-icon";
import { Trash2Icon } from "@animateicons/react/lucide/trash-2-icon";
import * as Static from "lucide-react";
import type { CSSProperties } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

// Keep the existing icon API while letting the containing control trigger motion.
function animatedIcon(Icon: typeof PlusIcon, Fallback: LucideIcon) {
  return function AnimatedIcon({
    size = 24,
    className,
    strokeWidth = 2,
    ...props
  }: LucideProps) {
    const host = useRef<HTMLSpanElement>(null);
    const handle = useRef<IconHandle>(null);
    const reduceMotion = useReducedMotion();
    useEffect(() => {
      if (reduceMotion) return;
      const trigger =
        host.current?.closest("button, .plan-card, .auth-mini, .rule-item") ||
        host.current;
      if (!trigger) return;
      const start = () => {
        if (trigger instanceof HTMLButtonElement && trigger.disabled) return;
        handle.current?.startAnimation();
      };
      const stop = () => handle.current?.stopAnimation();
      trigger.addEventListener("pointerenter", start);
      trigger.addEventListener("pointerleave", stop);
      trigger.addEventListener("pointerdown", start);
      trigger.addEventListener("focusin", start);
      trigger.addEventListener("focusout", stop);
      return () => {
        trigger.removeEventListener("pointerenter", start);
        trigger.removeEventListener("pointerleave", stop);
        trigger.removeEventListener("pointerdown", start);
        trigger.removeEventListener("focusin", start);
        trigger.removeEventListener("focusout", stop);
      };
    }, [reduceMotion]);
    const pixels =
      typeof size === "number" ? size : Number.parseFloat(size) || 24;
    return (
      <span
        ref={host}
        className={`animated-icon-slot ${className || ""}`}
        aria-hidden="true"
        style={
          {
            width: pixels,
            height: pixels,
            "--icon-stroke-width": strokeWidth,
          } as CSSProperties
        }
      >
        {reduceMotion ? (
          <Fallback {...props} size={pixels} strokeWidth={strokeWidth} />
        ) : (
          <Icon
            ref={handle}
            size={pixels}
            color={props.color}
            duration={0.7}
            className="animated-icon"
          />
        )}
      </span>
    );
  };
}

export const ArrowDownToLine = animatedIcon(
  DownloadIcon,
  Static.ArrowDownToLine,
);
export const ArrowRight = animatedIcon(ArrowRightIcon, Static.ArrowRight);
export const BookOpen = animatedIcon(BookOpenIcon, Static.BookOpen);
export const Clock3 = animatedIcon(ClockIcon, Static.Clock3);
export const ChartColumnIncreasing = animatedIcon(
  ChartColumnIncreasingIcon,
  Static.ChartColumnIncreasing,
);
export const Flag = animatedIcon(FlagIcon, Static.Flag);
export const Focus = animatedIcon(ScanIcon, Static.Focus);
export const LayoutGrid = animatedIcon(LayoutGridIcon, Static.LayoutGrid);
export const Maximize2 = animatedIcon(ExpandIcon, Static.Maximize2);
export const Minimize2 = animatedIcon(ShrinkIcon, Static.Minimize2);
export const Moon = animatedIcon(MoonIcon, Static.Moon);
export const Pencil = animatedIcon(PencilIcon, Static.Pencil);
export const Plus = animatedIcon(PlusIcon, Static.Plus);
export const RotateCcw = animatedIcon(RotateCcwIcon, Static.RotateCcw);
export const Sun = animatedIcon(SunIcon, Static.Sun);
export const Target = animatedIcon(TargetIcon, Static.Target);
export const Trash2 = animatedIcon(Trash2Icon, Static.Trash2);
