import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { Download, CheckCircle, Home, ExternalLink, Copy, Clock, AlertCircle } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';

export default function ThankYou() {
  const router = useRouter();
  const { ref } = router.query;
  const [vouchers, setVouchers] = useState([]);
  const [isPreorder, setIsPreorder] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ref) return;

    // Check for pending order from localStorage
    const pendingOrder = localStorage.getItem('pendingOrder');
    if (pendingOrder) {
      try {
        const order = JSON.parse(pendingOrder);
        if (order.reference === ref) {
          verifyPayment(order);
          localStorage.removeItem('pendingOrder');
          return;
        }
      } catch (_) {}
    }

    // Check lastOrder from old flow
    const data = localStorage.getItem('lastOrder');
    if (data) {
      try { setVouchers(JSON.parse(data)); } catch (_) {}
    }
    setVerifying(false);
  }, [ref]);

  const verifyPayment = async (order) => {
    try {
      const res = await axios.post('/api/verify-payment', {
        reference: order.reference,
        quantity: order.quantity,
        type: order.type,
        phone: order.phone,
        name: order.name,
        isPreorder: order.isPreorder || false,
      });

      if (res.data.preorder) {
        setIsPreorder(true);
      } else {
        setVouchers(res.data.vouchers || []);
        localStorage.setItem('lastOrder', JSON.stringify(res.data.vouchers));
      }
    } catch (e) {
      setError(e?.response?.data?.error || 'Verification failed. Contact support.');
    }
    setVerifying(false);
  };

  const getPortalDetails = (type) => {
    const t = type?.toUpperCase() || '';
    if (t.includes('BECE')) return { name: 'BECE Portal', url: 'https://eresults.waecgh.org' };
    if (t.includes('WASSCE') || t.includes('NOVDEC')) return { name: 'WASSCE Portal', url: 'https://ghana.waecdirect.org' };
    if (t.includes('CSSPS') || t.includes('PLACEMENT')) return { name: 'Placement Portal', url: 'https://www.cssps.gov.gh/' };
    return null;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied!');
  };

  const downloadPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.setTextColor(79, 70, 229);
    doc.text('WAEC GH CARDS ONLINE', 14, 22);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Purchase Date: ${new Date().toLocaleString()}`, 14, 30);
    doc.text('Your official voucher receipt.', 14, 35);
    doc.autoTable({
      head: [['Voucher Type', 'Serial Number', 'PIN']],
      body: vouchers.map(v => [v.type, v.serial, v.pin]),
      startY: 45,
      theme: 'grid',
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
    });
    const finalY = doc.lastAutoTable.finalY || 45;
    doc.setFontSize(9);
    doc.text('Keep this document safe. Use your PINs on the official WAEC/CSSPS portals.', 14, finalY + 10);
    doc.save(`Vouchers_${Date.now()}.pdf`);
    toast.success('PDF Downloaded!');
  };

  if (verifying) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center font-outfit">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-slate-500 font-semibold">Verifying your payment...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFDFD] flex flex-col items-center py-8 px-4 sm:justify-center font-outfit">
      <Toaster position="top-center" />
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-[2.5rem] p-6 md:p-12 shadow-xl shadow-slate-200/50">

        {/* Header */}
        <div className="text-center mb-8">
          <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${isPreorder ? 'bg-amber-50' : error ? 'bg-red-50' : 'bg-green-50'}`}>
            {isPreorder ? <Clock size={32} className="text-amber-500" /> :
             error ? <AlertCircle size={32} className="text-red-500" /> :
             <CheckCircle size={32} className="text-green-500" />}
          </div>
          {isPreorder ? (
            <>
              <h1 className="text-2xl md:text-3xl font-black text-slate-900 mb-2 tracking-tighter uppercase">Pre-Order Confirmed!</h1>
              <p className="text-sm md:text-base text-slate-500 font-medium">Payment received. Your vouchers will be sent via SMS when stock is available.</p>
            </>
          ) : error ? (
            <>
              <h1 className="text-2xl font-black text-red-600 mb-2 tracking-tighter uppercase">Verification Issue</h1>
              <p className="text-sm text-slate-500">{error}</p>
              <p className="text-sm text-slate-400 mt-2">If you were charged, please contact support with reference: <strong>{ref}</strong></p>
            </>
          ) : (
            <>
              <h1 className="text-2xl md:text-4xl font-black text-slate-900 mb-2 tracking-tighter uppercase">Payment Successful</h1>
              <p className="text-sm md:text-base text-slate-500 font-medium">Vouchers sent via SMS and shown below.</p>
            </>
          )}
        </div>

        {/* Pre-order info */}
        {isPreorder && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 mb-6">
            <div className="flex items-start gap-3">
              <Clock size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-amber-800 mb-1">What happens next?</p>
                <ul className="text-sm text-amber-700 space-y-1 list-disc ml-4">
                  <li>Your payment has been confirmed and recorded.</li>
                  <li>Once the admin uploads new vouchers, yours will be sent automatically via SMS.</li>
                  <li>You can also retrieve your vouchers using the Retrieve section on the home page.</li>
                  <li>Reference: <code className="bg-amber-100 px-1 rounded font-mono text-xs">{ref}</code></li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Voucher Cards */}
        {vouchers.length > 0 && (
          <div className="space-y-4 mb-8">
            {vouchers.map((v, i) => (
              <div key={i} className="bg-slate-50 border border-slate-100 rounded-2xl p-5 relative overflow-hidden">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest bg-blue-50 px-2 py-1 rounded">{v.type}</span>
                    <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase tracking-tighter">Serial Number</p>
                    <p className="text-sm font-mono text-slate-700">{v.serial}</p>
                  </div>
                  <button onClick={() => copyToClipboard(v.pin)} className="p-2 bg-white rounded-lg border border-slate-200 text-slate-400 hover:text-blue-600 transition-colors">
                    <Copy size={16} />
                  </button>
                </div>
                <div className="pt-4 border-t border-slate-200/60">
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter mb-1">Voucher PIN</p>
                  <p className="text-3xl font-black text-slate-900 tracking-tight select-all">{v.pin}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        {vouchers.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            <button onClick={downloadPDF} className="flex items-center justify-between p-4 bg-slate-900 rounded-xl text-white hover:bg-slate-800 transition-all">
              <span className="text-xs font-black uppercase tracking-widest">Download PDF Receipt</span>
              <Download size={16} />
            </button>
            {Array.from(new Set(vouchers.map(v => v.type))).map(type => {
              const portal = getPortalDetails(type);
              if (!portal) return null;
              return (
                <a key={type} href={portal.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-between p-4 bg-blue-600 rounded-xl text-white hover:bg-blue-700 transition-all">
                  <span className="text-xs font-black uppercase tracking-widest">Use on {portal.name}</span>
                  <ExternalLink size={16} />
                </a>
              );
            })}
          </div>
        )}

        <button onClick={() => router.push('/')} className="w-full flex items-center justify-center gap-2 bg-slate-100 text-slate-900 font-black py-4 rounded-xl text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">
          <Home size={18} /> Return Home
        </button>
      </div>

      <style jsx global>{`
        .font-outfit { font-family: 'Outfit', sans-serif; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    </div>
  );
}
