import type { DetailedHTMLProps, HTMLAttributes } from "react";

type TablineCheckoutProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  "api-url"?: string;
  "plan-id"?: string;
  label?: string;
  "budget-usdc"?: string;
};

// React 19 / @types/react 19 moved JSX types onto React.JSX; augment there instead of the old global `JSX`
// namespace so the custom element is recognized by both the app's tsconfig and Next's generated types.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "tabline-checkout": TablineCheckoutProps;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "tabline-checkout": TablineCheckoutProps;
    }
  }
}
