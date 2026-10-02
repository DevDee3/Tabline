import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page">
      <h1>That page is not on the tab.</h1>
      <p className="lede">The address may be outdated or the page may have moved.</p>
      <Link className="btn btn--primary" href="/">
        Back to shop
      </Link>
    </div>
  );
}
