/* The pixel-grid "Drive" loader is adapted from Beautiful UI (MIT,
   (c) 2026 Shane Levine, https://github.com/slev12397/beautiful-ui): a 3×3 grid
   whose cells brighten on a staggered wavefront — per-cell delay
   (col + |row − 1|) × 90ms, so two fronts are always in flight inside the 650ms
   `pixel-on` cycle. With motion off the grid simply rests at its dim plateau. */
export default function PixelLoader() {
  return <span className="pixel-loader" aria-hidden="true">
    {Array.from({ length: 9 }, (_, index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      return <span key={index} style={{ animationDelay: `${(col + Math.abs(row - 1)) * 90}ms` }} />;
    })}
  </span>;
}
