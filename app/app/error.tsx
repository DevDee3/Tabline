"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page">
      <h1>Something went wrong.</h1>
      <p className="lede">Tabline could not load this screen. You can try again or return to the shop.</p>
      <div className="row">
        <button className="btn btn--primary" onClick={() => reset()}>
          Try again
        </button>
        <Link className="btn btn--ghost" href="/">
          Back to shop
        </Link>
      </div>
    </div>
  );
}
