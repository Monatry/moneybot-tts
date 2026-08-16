"use client";

import { useEffect, useState } from "react";
import type { StoredImage } from "./avatarStore";

/**
 * Object URLs for a list of stored images, created once per list and revoked when the list
 * changes or the component unmounts.
 *
 * Creating one per render is the obvious mistake here: an unrevoked URL pins the whole blob
 * for the life of the page, and re-pointing an `<img>` at a fresh URL for the same bytes
 * makes the browser decode the image again. At avatar frame rates that is a dozen decodes a
 * second and a visible flicker.
 *
 * Keyed on the array identity, which is stable because both callers only replace the array
 * when the underlying images actually change.
 */
export function useObjectUrls(images: StoredImage[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    const created = images.map((image) => URL.createObjectURL(image.blob));
    setUrls(created);
    return () => {
      setUrls([]);
      created.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  return urls;
}

/**
 * The single-image form. Not `useObjectUrls([image])` — that call site would allocate a new
 * array on every render, and the array identity is what the effect above keys on, so the
 * URL would be revoked and recreated on every frame tick. This keys on the blob itself.
 */
export function useObjectUrl(image: StoredImage | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const blob = image?.blob ?? null;

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => {
      setUrl(null);
      URL.revokeObjectURL(created);
    };
  }, [blob]);

  return url;
}
