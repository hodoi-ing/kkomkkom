import { auth } from "../../../lib/auth";

export async function GET() {
  await auth();
  return Response.json([{ email: "user@example.com" }]);
}
