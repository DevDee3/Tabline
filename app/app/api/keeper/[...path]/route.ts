import { NextRequest, NextResponse } from "next/server";

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, context: RouteContext) {
  const target = process.env.KEEPER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_KEEPER_URL;
  if (!target) return NextResponse.json({ error: { code: "keeper_not_configured", message: "Keeper service is not configured." } }, { status: 503 });

  const { path } = await context.params;
  const upstream = new URL(`/` + path.map(encodeURIComponent).join("/"), target.endsWith("/") ? target : `${target}/`);
  upstream.search = request.nextUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const cookie = request.headers.get("cookie");
  if (contentType) headers.set("content-type", contentType);
  if (cookie) headers.set("cookie", cookie);

  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
    });
    const responseHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    if (responseType) responseHeaders.set("content-type", responseType);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) responseHeaders.set("set-cookie", setCookie);
    responseHeaders.set("cache-control", "no-store");
    return new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: { code: "keeper_unreachable", message: "The keeper service could not be reached." } }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
export const OPTIONS = forward;
