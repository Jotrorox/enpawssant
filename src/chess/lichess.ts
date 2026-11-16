// The Lichess account, shared by every tab. Signing in and the token live in Rust
// (`src-tauri/src/lichess.rs`); the frontend only learns the username.

import { invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";

export type LichessAccount = { username: string };

export type AccountState =
  | { status: "loading" }
  | { status: "signedOut"; error?: string }
  | { status: "signingIn" }
  | { status: "signedIn"; account: LichessAccount };

const store = createRoot(() => {
  const [state, setState] = createSignal<AccountState>({ status: "loading" });
  invoke<LichessAccount | null>("lichess_account")
    .then((account) => {
      // A sign-in started meanwhile knows better.
      if (state().status === "loading") {
        setState(account ? { status: "signedIn", account } : { status: "signedOut" });
      }
    })
    .catch(() => setState({ status: "signedOut" }));
  return { state, setState };
});

export const lichessAccount = store.state;

// Starting a sign-in cancels the previous one, which then only reports to its successor.
let attempt = 0;

/** Opens lichess.org in the browser and waits for the user to approve access. */
export async function signIn() {
  const current = ++attempt;
  store.setState({ status: "signingIn" });
  try {
    const account = await invoke<LichessAccount>("lichess_sign_in");
    if (current === attempt) store.setState({ status: "signedIn", account });
  } catch (reason) {
    if (current !== attempt) return;
    const message = String(reason);
    store.setState(
      message.includes("cancelled")
        ? { status: "signedOut" }
        : { status: "signedOut", error: message },
    );
  }
}

export function cancelSignIn() {
  void invoke("lichess_cancel_sign_in");
}

export async function signOut() {
  store.setState({ status: "signedOut" });
  await invoke("lichess_sign_out").catch(() => {});
}

/** Lichess no longer accepts the token, so the backend has already forgotten it. */
export function markSignedOut() {
  if (store.state().status === "signedIn") store.setState({ status: "signedOut" });
}
