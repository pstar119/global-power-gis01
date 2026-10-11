/**
 * 阶段57：应用级错误兜底（ErrorBoundary）。
 *
 * 为什么必须有：这是**离线桌面应用**，而 src/pages/MapPage.tsx 有 6300+ 行、
 * 10 个 useState / 12 个 useEffect 密集堆在渲染路径上。任何一次渲染期 throw
 * 都会让 React 卸载整棵树 ⇒ 白屏；桌面端既没有地址栏也没有刷新按钮，
 * 用户唯一的出路是重启应用，而且屏幕上没有任何线索。
 *
 * 兜底后至少给出三样：出了什么错、原始堆栈、以及两个自救动作。
 *
 * ⚠️ 刻意**不做自动重试**：渲染期错误通常可复现，自动重试会把界面锁死在
 *    崩溃—重试—崩溃的循环里；「重新加载页面」交给用户点。
 * ⚠️ 只接渲染/生命周期错误。事件回调与 Promise 里的错误不会卸载 React 树，
 *    不会白屏，不归它管。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // release 版没有控制台（tauri.conf.json 关掉了），所以这里既打日志也上屏。
    console.error("[app] 界面渲染抛错，已被 ErrorBoundary 接住", error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          boxSizing: "border-box",
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          background: "var(--gpg-bg, #1e1e1e)",
          color: "var(--gpg-text, #cccccc)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "20px" }}>界面出错了</h1>
        <p style={{ margin: 0, color: "var(--gpg-muted, #8c8c8c)", maxWidth: "72ch" }}>
          这是个离线应用，出错的内容不会自动上报。下面的信息请截图保存；先试「重新加载界面」，
          若每次都出错，重启应用仍失败说明是数据或配置问题（例如本机数据库损坏）。
        </p>
        <pre
          style={{
            margin: 0,
            padding: "12px",
            maxHeight: "40vh",
            overflow: "auto",
            background: "var(--gpg-panel-bg, #2d2d30)",
            border: "1px solid var(--gpg-border, #3c3c3c)",
            borderRadius: "4px",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
          }}
        >
          {String(error.stack ?? error.message ?? error)}
        </pre>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "6px 14px",
              borderRadius: "4px",
              border: "1px solid var(--gpg-accent, #007acc)",
              background: "var(--gpg-accent, #007acc)",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            重新加载界面
          </button>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: "6px 14px",
              borderRadius: "4px",
              border: "1px solid var(--gpg-border, #3c3c3c)",
              background: "var(--gpg-control-bg, #3c3c3c)",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            再试一次渲染
          </button>
        </div>
      </div>
    );
  }
}
