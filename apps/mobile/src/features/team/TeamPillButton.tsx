import { ActivityIndicator, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** The small pill button the team surfaces share. */
export function TeamPillButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "primary" | "secondary";
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly accessibilityLabel?: string;
}) {
  const primary = (props.tone ?? "secondary") === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true, busy: props.loading === true }}
      disabled={props.disabled === true || props.loading === true}
      onPress={props.onPress}
      className={cn(
        "min-h-9 flex-row items-center justify-center gap-1.5 rounded-full px-3.5 py-2 active:opacity-70",
        primary ? "bg-primary" : "border border-border bg-card",
        (props.disabled === true || props.loading === true) && "opacity-50",
      )}
    >
      {props.loading ? <ActivityIndicator size="small" /> : null}
      <Text
        className={cn(
          "text-sm font-t3-medium",
          primary ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
