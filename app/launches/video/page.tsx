import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The standalone video-launches list is now folded into the unified Launches
 * section (E5.1 / #595) behind the format tab. This route stays only as a
 * redirect so existing links / bookmarks land on the unified surface; the video
 * launch DETAIL pages keep living at `/launches/video/[id]`.
 */
export default function VideoLaunchesIndexPage(): never {
  redirect("/launches");
}
