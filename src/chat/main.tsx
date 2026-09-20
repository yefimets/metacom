import { render } from "ink";
import React from "react";

import { App } from "@/chat/app";
import { type Config, Store } from "@/chat/store";
import { themeByName } from "@/chat/themes";

/// Entry point called from bin/metacom.js: connect, then hand the terminal to Ink.
export const start = async ({ name, room, config, theme }: { name: string; room: string; config: Config; theme?: string | null }): Promise<void> => {
  const store = new Store({ name, room, config });
  await store.start();
  const chosen = themeByName(theme ?? process.env["MC_THEME"]) ?? themeByName("default")!;
  const instance = render(<App store={store} theme={chosen} />, { exitOnCtrlC: false, patchConsole: false });
  await instance.waitUntilExit();
  process.exit(0);
};
