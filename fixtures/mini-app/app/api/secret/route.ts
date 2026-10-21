export async function GET() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
