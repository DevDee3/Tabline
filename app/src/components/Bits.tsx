
export function DemoNotice() {
  return (
    <p className="notice" role="note">
      Simulated data. Nothing on this screen touches a wallet or a chain. Run the keeper and set <code>NEXT_PUBLIC_KEEPER_URL</code> to use real payments.
    </p>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function LoadingNote({ message = "Loading…" }: { message?: string }) {
  return (
    <p className="hint" role="status" aria-live="polite">
      {message}
    </p>
  );
}
