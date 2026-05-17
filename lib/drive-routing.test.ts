import { describe, expect, it } from "vitest";

import { FOLDER_IDS, routeCreative, routeParentFolder, routeSubpath } from "./drive-routing";

describe("FOLDER_IDS", () => {
  it("exposes the full v1 folder map", () => {
    expect(FOLDER_IDS["3_image_ads"]).toBeTruthy();
    expect(FOLDER_IDS["4.2_video_output"]).toBeTruthy();
    expect(FOLDER_IDS["0_sourcing"]).toBeTruthy();
  });
});

describe("routeParentFolder", () => {
  it("returns the image folder for image creatives", () => {
    expect(routeParentFolder({ fmt: "image" })).toBe("3_image_ads");
  });

  it("returns the video folder for video creatives", () => {
    expect(routeParentFolder({ fmt: "video" })).toBe("4.2_video_output");
  });
});

describe("routeSubpath", () => {
  it("roofing+branded with state+slug nests both", () => {
    expect(
      routeSubpath({
        service_type: "roofing",
        branded: true,
        state: "TX",
        client_slug: "acme",
      }),
    ).toBe("TX/acme/");
  });

  it("roofing+branded with only state", () => {
    expect(
      routeSubpath({
        service_type: "roofing",
        branded: true,
        state: "TX",
        client_slug: null,
      }),
    ).toBe("TX/");
  });

  it("roofing+branded with only client_slug", () => {
    expect(
      routeSubpath({
        service_type: "roofing",
        branded: true,
        state: null,
        client_slug: "acme",
      }),
    ).toBe("acme/");
  });

  it("roofing+branded with neither falls back to _Universal/", () => {
    expect(
      routeSubpath({
        service_type: "roofing",
        branded: true,
        state: null,
        client_slug: null,
      }),
    ).toBe("_Universal/");
  });

  it("roofing+unbranded is always _Universal/", () => {
    expect(
      routeSubpath({
        service_type: "roofing",
        branded: false,
        state: "TX",
        client_slug: "acme",
      }),
    ).toBe("_Universal/");
  });

  it("remodeling is always _Universal/", () => {
    expect(
      routeSubpath({
        service_type: "remodeling",
        branded: true,
        state: "TX",
        client_slug: "acme",
      }),
    ).toBe("_Universal/");
  });
});

describe("routeCreative", () => {
  it("returns parent folder + subpath in one call", () => {
    const out = routeCreative({
      service_type: "roofing",
      branded: true,
      state: "TX",
      client_slug: "acme",
      fmt: "image",
    });
    expect(out.parent_folder_key).toBe("3_image_ads");
    expect(out.parent_folder_id).toBe(FOLDER_IDS["3_image_ads"]);
    expect(out.subpath).toBe("TX/acme/");
  });
});
