import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import Popup from './Popup';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
if (location.hash === '#popup') {
  // Frameless transparent window: only the card is painted.
  document.documentElement.classList.add('popup');
  root.render(<Popup />);
} else root.render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: theme.defaultAlgorithm,
      token: { colorPrimary: '#07c160', borderRadius: 8, fontSize: 13 },
      components: { Layout: { siderBg: '#ffffff', headerBg: '#ffffff' } },
    }}
  >
    <AntApp style={{ height: "100%" }}>
      <App />
    </AntApp>
  </ConfigProvider>,
);
