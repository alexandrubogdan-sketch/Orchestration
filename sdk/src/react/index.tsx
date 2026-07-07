/**
 * React bindings for @alphapayments/checkout-sdk, ergonomically
 * matching @stripe/react-stripe-js: a <CheckoutProvider> context
 * component, a useCheckout() hook, and a <CardElement/> component
 * that mounts/unmounts the vanilla CardElement via a ref inside
 * useEffect.
 *
 * react/react-dom are optional peer dependencies (see package.json) —
 * this subpath is the ONLY part of the SDK that imports them, so
 * merchants who only use the vanilla API never need React installed.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { loadCheckout, type CheckoutSession, type LoadCheckoutOptions } from "../session";
import type { CardElement as VanillaCardElement } from "../elements/card-element";
import type { Appearance } from "../appearance";
import type { CardElementChangeState } from "../drivers/types";

export type { ConfirmResult, Payment, LoadCheckoutOptions } from "../session";
export type { CardElementChangeState } from "../drivers/types";
export type { Appearance } from "../appearance";

const CheckoutContext = createContext<CheckoutSession | null | undefined>(undefined);

export interface CheckoutProviderProps extends LoadCheckoutOptions {
  children: ReactNode;
  /** Rendered in place of children while the session is loading. */
  loading?: ReactNode;
  /** Rendered in place of children if loadCheckout() rejects. */
  onError?: (error: unknown) => void;
}

/**
 * Loads a checkout session once (keyed on sessionId/clientSecret/apiBaseUrl)
 * and provides it to descendants via useCheckout().
 */
export function CheckoutProvider(props: CheckoutProviderProps): JSX.Element {
  const { children, loading, onError, ...loadOptions } = props;
  const [session, setSession] = useState<CheckoutSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSession(null);

    loadCheckout(loadOptions)
      .then((created) => {
        if (!cancelled) {
          setSession(created);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onError?.(error);
        }
      });

    return () => {
      cancelled = true;
    };
    // loadOptions is re-derived every render, so this effect
    // intentionally depends on its scalar identity fields directly
    // rather than the loadOptions object itself (the react-hooks
    // exhaustive-deps lint rule isn't wired up in this package's
    // minimal eslint config, so there's no plugin warning to
    // suppress here — this comment documents the same reasoning by
    // hand).
  }, [loadOptions.apiBaseUrl, loadOptions.sessionId, loadOptions.clientSecret]);

  if (!session) {
    return <>{loading ?? null}</>;
  }

  return <CheckoutContext.Provider value={session}>{children}</CheckoutContext.Provider>;
}

/**
 * Returns the active CheckoutSession. Must be called from a component
 * mounted underneath <CheckoutProvider>; throws otherwise (matching
 * @stripe/react-stripe-js's useStripe()/useElements() contract of
 * failing loudly on misuse rather than silently returning null).
 */
export function useCheckout(): CheckoutSession {
  const session = useContext(CheckoutContext);
  if (session === undefined) {
    throw new Error("useCheckout() must be called within a <CheckoutProvider>.");
  }
  if (session === null) {
    throw new Error("useCheckout() called before the checkout session finished loading.");
  }
  return session;
}

/**
 * Like useCheckout(), but returns null while loading instead of
 * throwing — useful for components that want to render a fallback
 * UI during the initial load.
 */
export function useCheckoutMaybe(): CheckoutSession | null {
  const session = useContext(CheckoutContext);
  return session ?? null;
}

export interface CardElementProps {
  appearance?: Appearance;
  onChange?: (state: CardElementChangeState) => void;
  className?: string;
  /** Inline styles applied to the mount-point div. */
  style?: React.CSSProperties;
}

/**
 * Mounts a vanilla CardElement into a div this component owns,
 * following @stripe/react-stripe-js's <CardElement/> ergonomics:
 * mount happens in useEffect after the session becomes available,
 * and unmount happens on cleanup.
 *
 * Also registers itself as the checkout session's "active" element
 * (via `checkout.registerActiveElement()`), which is what lets
 * `checkout.confirm()` be called with no arguments in React — the
 * session already knows which CardElement to tokenize.
 */
export function CardElement(props: CardElementProps): JSX.Element {
  const { appearance, onChange, className, style } = props;
  const checkout = useCheckout();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<VanillaCardElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const element = checkout.createElement("card", { appearance });
    elementRef.current = element;
    element.mount(container);
    element.on("change", (state) => {
      onChangeRef.current?.(state);
    });
    checkout.registerActiveElement(element);

    return () => {
      element.unmount();
      elementRef.current = null;
      checkout.registerActiveElement(null);
    };
    // Re-mount if the session instance or appearance object changes.
    // onChange is intentionally excluded — it's read through
    // onChangeRef so identity changes don't force a remount.
  }, [checkout, appearance]);

  return <div ref={containerRef} className={className} style={style} />;
}

export interface ExpressCheckoutElementProps {
  className?: string;
  style?: React.CSSProperties;
  onReady?: (available: boolean) => void;
  onPaymentMethod?: (paymentMethodRef: string) => void;
}

/**
 * React wrapper for the vanilla ExpressCheckoutElement. Renders an
 * (empty, unstyled) container div always; the wrapped element
 * decides for itself whether to render a button inside it, per its
 * own auto-hide-if-unsupported behavior.
 */
export function ExpressCheckoutElement(props: ExpressCheckoutElementProps): JSX.Element {
  const { className, style, onReady, onPaymentMethod } = props;
  const checkout = useCheckout();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const element = checkout.createElement("expressCheckout");
    element.on("ready", (state) => onReady?.(state.available));
    element.on("paymentmethod", (event) => onPaymentMethod?.(event.paymentMethodRef));
    void element.mount(container);

    return () => {
      element.unmount();
    };
    // onReady/onPaymentMethod are intentionally excluded — this
    // effect should only re-run when the checkout session changes,
    // not on every render caused by a new inline callback prop.
  }, [checkout]);

  return <div ref={containerRef} className={className} style={style} />;
}
