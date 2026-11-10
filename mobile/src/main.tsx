import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppMotion } from '@web/components/Motion';
import { paintPreferences, readPreferences } from './preferences';
import MobileApp from './MobileApp';
import '@web/chat-blocks.css';
import '@web/motion.css';
import '@web/dialogs.css';
import './mobile.css';

paintPreferences(readPreferences());
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AppMotion enabled><MobileApp /></AppMotion></React.StrictMode>);
