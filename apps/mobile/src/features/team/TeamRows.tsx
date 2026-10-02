import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Padded content block inside a SettingsSection card. */
export function TeamCardBody(props: { readonly children: ReactNode; readonly divided?: boolean }) {
  return (
    <View className={cn("gap-2 px-4 py-3.5", props.divided && "border-t border-border-subtle")}>
      {props.children}
    </View>
  );
}

export function TeamMutedText(props: { readonly children: ReactNode }) {
  return <Text className="text-sm text-foreground-muted">{props.children}</Text>;
}

/** A tappable or static list row: optional icon, title, detail, and trailing slot. */
export function TeamRow(props: {
  readonly title: string;
  readonly detail?: string | null;
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly checked?: boolean;
  readonly trailing?: ReactNode;
  readonly divided?: boolean;
  readonly muted?: boolean;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
}) {
  const content = (
    <View
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-3",
        props.divided && "border-t border-border-subtle",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={20}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn(
            "text-base",
            props.muted ? "italic text-foreground-muted" : "text-foreground",
          )}
          numberOfLines={2}
        >
          {props.title}
        </Text>
        {props.detail ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={3}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.trailing}
      {props.checked ? (
        <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
      ) : null}
    </View>
  );
  if (!props.onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={props.checked === undefined ? undefined : { selected: props.checked }}
      className="active:opacity-70"
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  );
}
