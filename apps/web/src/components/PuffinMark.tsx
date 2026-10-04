/* oxlint-disable shadcn/no-raw-colors -- Fixed brand artwork matches the native app icons and canonical puffin SVG. */
import type { SVGProps } from "react";

export function PuffinMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#193c49"
        d="M38 103C27 89 27 65 38 52C36 27 50 15 68 15C89 15 98 34 94 54C104 71 102 92 88 105Z"
      />
      <path
        fill="#fff8ee"
        d="M48 51C42 40 49 25 65 25C79 25 88 36 86 49C84 61 74 67 62 63C79 69 85 85 79 101H45C36 86 39 64 48 51Z"
      />
      <path fill="#ff9438" d="M83 37L113 51L84 62Z" />
      <path fill="#e65e40" d="M97 44L113 51L97 57Z" />
      <path fill="#193c49" d="M76 40A4 4 0 1 0 68 40A4 4 0 1 0 76 40Z" />
      <path fill="#ff9438" d="M42 103H58L64 112H35ZM74 103H88L96 112H70Z" />
    </svg>
  );
}
