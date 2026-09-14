import { type Metadata } from "next";
import { GuestClient } from "./guestClient";

export const dynamic = "force-dynamic";

// A share link must never end up in an index. The URL IS the credential, so
// anywhere it can be crawled from — a pasted message in a public channel, a
// synced note — would otherwise publish the bed.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "Your side of the bed",
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <GuestClient token={token} />;
}
