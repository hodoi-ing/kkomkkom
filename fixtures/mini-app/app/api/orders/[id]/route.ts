import { auth } from "../../../../lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await auth();
  const { id } = await params;
  return Response.json({ id, email: "user@example.com" });
}
