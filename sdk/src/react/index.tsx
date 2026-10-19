import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  loadCheckout,
  type CheckoutSession,
  type LoadCheckoutOptions,
} from "../session";
import type { CardElement as VanillaCardElement } from "../elements/card-element";
import type { Appearance } from "../appearance";
import type { CardElementChangeState } from "../drivers/types";

export type { ConfirmResult, Payment, LoadCheckoutOptions } from "../session";
export type { CardElementChangeState } from "../drivers/types";
export type { Appearance } from "../appearance";

const CheckoutContext = createContext<CheckoutSession | null | undefined>(
  undefined,
);

export interface CheckoutProviderProps extends LoadCheckoutOptions {
  children: ReactNode;

  loading?: ReactNode;

  onError?: (error: unknown) => void;
}

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
  }, [loadOptions.apiBaseUrl, loadOptions.sessionId, loadOptions.clientSecret]);

  if (!session) {
    return <>{loading ?? null}</>;
  }

  return (
    <CheckoutContext.Provider value={session}>
      {children}
    </CheckoutContext.Provider>
  );
}

export function useCheckout(): CheckoutSession {
  const session = useContext(CheckoutContext);
  if (session === undefined) {
    throw new Error(
      "useCheckout() must be called within a <CheckoutProvider>.",
    );
  }
  if (session === null) {
    throw new Error(
      "useCheckout() called before the checkout session finished loading.",
    );
  }
  return session;
}

export function useCheckoutMaybe(): CheckoutSession | null {
  const session = useContext(CheckoutContext);
  return session ?? null;
}

export interface CardElementProps {
  appearance?: Appearance;
  onChange?: (state: CardElementChangeState) => void;
  className?: string;

  style?: React.CSSProperties;
}

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
  }, [checkout, appearance]);

  return <div ref={containerRef} className={className} style={style} />;
}

export interface ExpressCheckoutElementProps {
  className?: string;
  style?: React.CSSProperties;
  onReady?: (available: boolean) => void;
  onPaymentMethod?: (paymentMethodRef: string) => void;
}

export function ExpressCheckoutElement(
  props: ExpressCheckoutElementProps,
): JSX.Element {
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
    element.on("paymentmethod", (event) =>
      onPaymentMethod?.(event.paymentMethodRef),
    );
    void element.mount(container);

    return () => {
      element.unmount();
    };
  }, [checkout]);

  return <div ref={containerRef} className={className} style={style} />;
}
