import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./AppLayout.module.css";

/**
 * Rust 后端连通性自检。
 * 调用 src-tauri 中的 `greet` 命令，用于验证前端与 Rust 后端的通信链路仍然可用。
 */
function GreetSelfCheck() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <div className={styles.selfCheck}>
      <h2 className={styles.selfCheckTitle}>Rust 后端连通性自检</h2>
      <p className={styles.selfCheckHint}>
        调用 src-tauri 中的 greet 命令，验证前端与 Rust 后端的通信链路。
      </p>

      <form
        className={styles.selfCheckForm}
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>

      <p className={styles.selfCheckResult} aria-live="polite">
        {greetMsg}
      </p>
    </div>
  );
}

export default GreetSelfCheck;
