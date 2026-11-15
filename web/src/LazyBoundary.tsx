// A lazily loaded module that fails to load (the service was upgraded while the page was open, so the old chunk is gone, or the
// network dropped) would otherwise unmount the whole page. This keeps the failure in place with a reload button.
import { Component, type ReactNode } from 'react';

export class LazyBoundary extends Component<{ what: string; className?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className={this.props.className} role="alert"><p>{this.props.what}加载失败，可能是服务刚升级或网络中断，请刷新页面。</p><button type="button" onClick={() => window.location.reload()}>刷新页面</button></div>;
  }
}
