"use client";
import dynamic from "next/dynamic";
const Agent = dynamic(() => import("../../src/views/Agent").then((m) => m.Agent), { ssr: false });
export default Agent;
