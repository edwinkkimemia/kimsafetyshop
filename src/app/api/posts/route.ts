export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listPosts } from "@/lib/db";

export async function GET() {
  try {
    const posts = (await listPosts()).map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      category: p.category,
      excerpt: p.excerpt,
      cover: p.cover,
      author: p.author,
      read_time: p.read_time,
      created_at: p.created_at,
    }));
    return NextResponse.json(
      { posts },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } }
    );
  } catch (err) {
    // 53300 fallback: never 500 the blog listing.
    console.error("[api/posts] error:", (err as Error).message);
    return NextResponse.json(
      { posts: [] },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } }
    );
  }
}
