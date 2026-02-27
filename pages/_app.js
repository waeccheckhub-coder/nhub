import { SessionProvider } from "next-auth/react";
import WhatsAppIcon from '../components/WhatsAppIcon'; // Ensure this path is correct
import '../styles/globals.css';

export default function App({ Component, pageProps: { session, ...pageProps } }) {
  return (
    <SessionProvider session={session}>
      {/* Main Application Component */}
      <Component {...pageProps} />

      {/* Persistent WhatsApp Floating Icon */}
      <WhatsAppIcon />
      
      {/* Global Style overrides for the Floating Icon if needed */}
      <style jsx global>{`
        @keyframes pulse-green {
          0% { box-shadow: 0 0 0 0 rgba(37, 211, 102, 0.7); }
          70% { box-shadow: 0 0 0 15px rgba(37, 211, 102, 0); }
          100% { box-shadow: 0 0 0 0 rgba(37, 211, 102, 0); }
        }
        .whatsapp-pulse {
          animation: pulse-green 2s infinite;
        }
      `}</style>
    </SessionProvider>
  );
}
