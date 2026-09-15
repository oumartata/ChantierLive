import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ChantierLive",
    short_name: "ChantierLive",
    description: "Socle technique installable (PWA)",
    start_url: "/",
    display: "standalone",
    background_color: "#f3eee4",
    theme_color: "#126b54",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
