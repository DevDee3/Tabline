"use client";
import dynamic from "next/dynamic";
const Merchant = dynamic(() => import("../../src/views/Merchant").then((m) => m.Merchant), { ssr: false });
export default Merchant;
