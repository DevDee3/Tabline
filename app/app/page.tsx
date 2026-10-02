"use client";
import dynamic from "next/dynamic";

// The Shop page pulls in the <tabline-checkout> custom element (extends HTMLElement at module scope), which
// can't be evaluated during server-side prerendering -- load it client-only.
const Shop = dynamic(() => import("../src/views/Shop").then((m) => m.Shop), { ssr: false });
export default Shop;
