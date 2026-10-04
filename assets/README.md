# Puff Collab brand assets

`prod/logo.svg` is the puffin used in the application and README. The Icon Composer projects in `prod`, `dev`, and `nightly` use the same puffin layer, with navy, teal, and purple backgrounds. Historical asset filenames remain stable so packaging and existing clients keep finding their icons.

Run `vp run icons:export` to regenerate desktop, iOS, web, marketing, and Windows assets. This uses Icon Composer's command-line renderer. Classic macOS PNGs use the same rendered artwork with an 824-pixel body centered on a transparent 1024-pixel canvas; this flat export is reproducible without opening the GUI. Run `vp run icons:check` to verify every generated export, including macOS icons and favicons.

Run `vp run icons:export:android` after changing the vector layer. Android launcher foregrounds and splash images keep the puffin inside the adaptive icon safe area. The web and React Native `PuffinMark` components, and the hub link page, use the same vector paths. Update those paths together when changing the mark.
