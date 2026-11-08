import React, { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="login"><div className="connection-error" role="alert"><h1>Не удалось открыть страницу</h1><p>Обновите её. Если ошибка повторится, попробуйте другой браузер.</p><a className="button" href="">Обновить страницу</a></div></main>;
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AppBoundary><App /></AppBoundary></React.StrictMode>);
