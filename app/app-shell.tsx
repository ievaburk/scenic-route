"use client";

/**
 * Decides what a visitor sees: onboarding once, the app thereafter.
 *
 * Preferences load from local storage, which can only happen on the client, so
 * this renders nothing until it knows — showing onboarding for a frame to
 * somebody who completed it last week is worse than a moment of blank.
 */
import { useState, useSyncExternalStore } from "react";
import Onboarding from "./onboarding";
import LoopMap from "./loop-map";
import {
  unknownPrefsSnapshot,
  prefsSnapshot,
  savePrefs,
  subscribe,
  type Prefs,
} from "@/lib/prefs";

export default function AppShell() {
  // null until hydration completes — see unknownPrefsSnapshot.
  const prefs = useSyncExternalStore(subscribe, prefsSnapshot, unknownPrefsSnapshot);
  const [editing, setEditing] = useState(false);

  if (!prefs) return <div className="h-dvh w-full bg-white" />;

  if (!prefs.onboarded || editing) {
    return (
      <Onboarding
        initial={prefs}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <LoopMap
      prefs={prefs}
      onEditPrefs={() => setEditing(true)}
      onPrefsChange={savePrefs}
    />
  );
}
