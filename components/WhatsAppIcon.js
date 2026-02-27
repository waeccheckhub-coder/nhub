import { MessageCircle } from 'lucide-react';

export default function WhatsAppIcon() {
  const phoneNumber = "233597622713"; // <-- REPLACE WITH YOUR NUMBER (233...)
  const message = "Hello Waec Gh Cards, I need assistance with a voucher.";
  const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

  return (
    <a
      href={whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-6 right-6 z-[999] flex items-center justify-center w-15 h-15 p-3.5 bg-[#25D366] text-white rounded-full shadow-2xl hover:scale-110 transition-all duration-300 group whatsapp-pulse"
      aria-label="Contact support on WhatsApp"
    >
      {/* Label Tooltip */}
      <span className="absolute right-20 bg-white border border-slate-200 text-slate-800 text-sm font-bold py-2 px-4 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-xl">
        Chat with Support 💬
      </span>
      
      <MessageCircle size={32} fill="white" />
    </a>
  );
}
