import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { sanitizePostHtml } from "@/lib/blog";
import { listPosts, getPostBySlug, createPost, updatePost, deletePost, type PostInput } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { sendContentNewsletter } from "@/lib/newsletter-send";

function parseBody(body: unknown): PostInput | null {
  const b = body as Partial<PostInput> & { title?: string; content?: string };
  if (!b || typeof b !== "object") return null;
  const title = String(b.title ?? "").trim();
  if (!title) return null;
  const slug = String(b.slug ?? "").trim().toLowerCase() || slugify(title);
  return {
    slug: slugify(slug),
    title,
    category: String(b.category ?? "News").trim() || "News",
    excerpt: String(b.excerpt ?? "").trim().slice(0, 300),
    content: sanitizePostHtml(String(b.content ?? "")),
    cover: typeof b.cover === "string" && b.cover ? b.cover : null,
    author: String(b.author ?? "KimSafety Team").trim() || "KimSafety Team",
    read_time: String(b.read_time ?? "5 min read").trim() || "5 min read",
    published: b.published !== false,
  };
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  try {
    const rows = await listPosts(true).catch(() => [] as Awaited<ReturnType<typeof listPosts>>);
    const posts = rows.map((p) => ({ ...p, published: Boolean(p.published) }));
    return NextResponse.json({ posts });
  } catch (err) {
    console.error("[admin/posts] error:", (err as Error).message);
    return NextResponse.json({ posts: [] });
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const input = parseBody(body);
  if (!input) return NextResponse.json({ error: "Title is required" }, { status: 400 });
  if (await getPostBySlug(input.slug, true)) {
    return NextResponse.json({ error: `Slug "${input.slug}" already exists` }, { status: 409 });
  }
  const post = await createPost(input);
  if (post.published) {
    // Fire-and-forget: a newly published post is automatically mailed to all
    // newsletter subscribers. A failure here must never block the publish.
    sendContentNewsletter({ ...post, kind: "blog" }).catch((err) => console.error("[blog] newsletter hook failed:", err));
  }
  return NextResponse.json({ post }, { status: 201 });
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const b = body as { slug?: string };
  const slug = b?.slug;
  if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  const input = parseBody(body);
  if (!input) return NextResponse.json({ error: "Title is required" }, { status: 400 });
  const conflict = await getPostBySlug(input.slug, true);
  if (conflict && conflict.slug !== slug) {
    return NextResponse.json({ error: `Slug "${input.slug}" already exists` }, { status: 409 });
  }
  const before = await getPostBySlug(slug, true);
  const post = await updatePost(slug, input);
  if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  // Only mail subscribers on the draft → published transition, not on every edit.
  if (post.published && before && !before.published) {
    sendContentNewsletter({ ...post, kind: "blog" }).catch((err) => console.error("[blog] newsletter hook failed:", err));
  }
  return NextResponse.json({ post: { ...post, published: Boolean(post.published) } });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  await deletePost(slug);
  return NextResponse.json({ ok: true });
}
