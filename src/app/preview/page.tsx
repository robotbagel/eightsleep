import { notFound } from "next/navigation";
import PreviewClient from "./previewClient";

// Development-only visual harness: renders every chart and shell primitive
// against a REAL captured pod night (src/app/preview/fixture.json), so the
// design can be checked without a live Eight Sleep session. It 404s in
// production and is never linked from the app.
export const dynamic = "force-dynamic";

export default function PreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PreviewClient />;
}
