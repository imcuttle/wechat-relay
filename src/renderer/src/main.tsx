import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
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
