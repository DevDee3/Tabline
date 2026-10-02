"use client";
import dynamic from "next/dynamic";
const Tabs = dynamic(() => import("../../src/views/Tabs").then((m) => m.Tabs), { ssr: false });
export default Tabs;
