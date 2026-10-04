import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

export function PuffinMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Puff Collab"
      height={props.height}
      width={props.height}
      viewBox="0 0 128 128"
    >
      <Path
        fill="#193c49"
        d="M38 103C27 89 27 65 38 52C36 27 50 15 68 15C89 15 98 34 94 54C104 71 102 92 88 105Z"
      />
      <Path
        fill="#fff8ee"
        d="M48 51C42 40 49 25 65 25C79 25 88 36 86 49C84 61 74 67 62 63C79 69 85 85 79 101H45C36 86 39 64 48 51Z"
      />
      <Path fill="#ff9438" d="M83 37L113 51L84 62Z" />
      <Path fill="#e65e40" d="M97 44L113 51L97 57Z" />
      <Path fill="#193c49" d="M76 40A4 4 0 1 0 68 40A4 4 0 1 0 76 40Z" />
      <Path fill="#ff9438" d="M42 103H58L64 112H35ZM74 103H88L96 112H70Z" />
    </Svg>
  );
}
