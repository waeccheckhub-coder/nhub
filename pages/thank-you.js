import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { Download, CheckCircle, Home, ExternalLink, Copy, Clock, AlertCircle, RefreshCw } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';

export default function ThankYou() {
  const router = useRouter();
  const { ref } = router.query;
  
  const [vouchers, setVouchers] = useState([]);
  const [isPreorder, setIsPreorder] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [error, setError] = useState(null);
  
  // Use a ref to ensure we only verify once per page load
  const hasVerified = useRef(false);

  useEffect(() => {
    // Wait until the router is ready and the ref exists
    if (!router.isReady || !ref) return;

    if (!hasVerified.current) {
      verifyPayment(ref);
      hasVerified.current = true;
    }
  }, [router.isReady, ref]);

  const verifyPayment = async (reference) => {
    setVerifying(true);
    setError(null);
    try {
      // We only send the reference. The backend retrieves the rest from the DB.
      const res = await axios.post('/api/verify-payment', { reference });

      if (res.data.preorder) {
        setIsPreorder(true);
      } else {
        setVouchers(res.data.vouchers || []);
      }
    } catch (e) {
      const errorMessage = e?.response?.data?.error || 'Verification failed. Please refresh or contact support.';
      setError(errorMessage);
    } finally {
      setVerifying(false);
    }
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
    toast.success('Copied to clipboard!');
  };

  const downloadPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(22);
    doc.setTextColor(79, 70, 229); // Indigo color
    doc.text('WAEC GH CARDS', 14, 22);
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Reference: ${ref}`, 14, 30);
    doc.text(`Date: ${new Date().toLocaleString()}`, 14, 35);

    doc.autoTable({
      head: [['Voucher Type', 'Serial Number', 'PIN']],
      body: vouchers.map(v => [v.type || 'WAEC Voucher', v.serial, v.pin]),
      startY: 45,
      theme: 'grid',
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
    });

    const finalY = doc.lastAutoTable.finalY || 45;
    doc.setFontSize(9);
    doc.text('This is an official digital receipt. Keep your PINs private.', 14, finalY + 10);
    
    doc.save(`WAEC_Vouchers_${ref}.pdf`);
    toast.success('Receipt Downloaded!');
  };

  // --- STATE: LOADING ---
  if (verifying) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center font-outfit">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-slate-500 font-semibold animate-pulse">Confirming your payment...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFDFD] flex flex-col items-center py-8 px-4 sm:justify-center font-outfit">
      <Toaster position="top-center" />
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-[2.5rem] p-6 md:p-12 shadow-xl shadow-slate-200/50">

        {/* Header Section */}
        <div className="text-center mb-8">
          <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${
            isPreorder ? 'bg-amber-50' : error ? 'bg-red-50' : 'bg-green-50'
          }`}>
            {isPreorder ? <Clock size={40} className="text-amber-500" /> :
             error ? <AlertCircle size={40} className="text-red-500" /> :
             <CheckCircle size={40} className="text-green-500" />}
          </div>

          {isPreorder ? (
            <>
              <h1 className="text-2xl md:text-3xl font-black text-slate-900 mb-2 tracking-tighter uppercase">Pre-Order Received</h1>
              <p className="text-sm md:text-base text-slate-500 font-medium px-4">
                We've confirmed your payment, but we're currently out of stock. Your vouchers will be sent via SMS immediately once restocked.
              </p>
            </>
          ) : error ? (
            <>
              <h1 className="text-2xl font-black text-red-600 mb-2 tracking-tighter uppercase">Verification Failed</h1>
              <p className="text-sm text-slate-500 mb-4">{error}</p>
              <button 
                onClick={() => verifyPayment(ref)}
                className="inline-flex items-center gap-2 text-indigo-600 font-bold text-sm hover:underline"
              >
                <RefreshCw size={16} /> Try Again
              </button>
            </>
          ) : (
            <>
              <h1 className="text-2xl md:text-4xl font-black text-slate-900 mb-2 tracking-tighter uppercase">Purchase Successful</h1>
              <p className="text-sm md:text-base text-slate-500 font-medium">Your vouchers are ready. A copy has been sent to your phone.</p>
            </>
          )}
        </div>

        {/* Pre-order Notice */}
        {isPreorder && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 mb-8">
            <h3 className="font-bold text-amber-800 flex items-center gap-2 mb-2">
              <Clock size={18} /> Next Steps
            </h3>
            <ul className="text-sm text-amber-700 space-y-2 list-disc ml-5">
              <li>Your reference: <span className="font-mono font-bold">{ref}</span></li>
              <li>You do not need to pay again.</li>
              <li>Our team has been alerted to restock immediately.</li>
            </ul>
          </div>
        )}

        {/* Voucher Display Grid */}
        {!error && !isPreorder && vouchers.length > 0 && (
          <div className="space-y-4 mb-8">
            {vouchers.map((v, i) => (
              <div key={i} className="bg-slate-50 border border-slate-100 rounded-2xl p-5 group transition-all hover:border-indigo-200">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2 py-1 rounded">
                      {v.type || 'WAEC Voucher'}
                    </span>
                    <p className="text-[10px] text-slate-400 font-bold mt-3 uppercase tracking-tighter">Serial Number</p>
                    <p className="text-sm font-mono text-slate-700 font-bold">{v.serial}</p>
                  </div>
                  <button 
                    onClick={() => copyToClipboard(v.pin)} 
                    className="p-3 bg-white rounded-xl border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-200 transition-all shadow-sm"
                    title="Copy PIN"
                  >
                    <Copy size={18} />
                  </button>
                </div>
                <div className="pt-4 border-t border-slate-200/60">
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter mb-1">Voucher PIN</p>
                  <p className="text-3xl font-black text-slate-900 tracking-tight break-all">
                    {v.pin}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action Buttons */}
        {!error && !isPreorder && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            <button 
              onClick={downloadPDF} 
              className="flex items-center justify-between p-4 bg-slate-900 rounded-xl text-white hover:bg-slate-800 transition-all shadow-lg shadow-slate-200"
            >
              <span className="text-xs font-black uppercase tracking-widest">Download Receipt</span>
              <Download size={18} />
            </button>
            
            {/* Logic to show the correct portal link */}
            {vouchers.length > 0 && getPortalDetails(vouchers[0].type) && (
              <a 
                href={getPortalDetails(vouchers[0].type).url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="flex items-center justify-between p-4 bg-indigo-600 rounded-xl text-white hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
              >
                <span className="text-xs font-black uppercase tracking-widest">Open WAEC Portal</span>
                <ExternalLink size={18} />
              </a>
            )}
          </div>
        )}

        {/* Footer Link */}
        <button 
          onClick={() => router.push('/')} 
          className="w-full flex items-center justify-center gap-2 bg-slate-100 text-slate-900 font-black py-4 rounded-xl text-xs uppercase tracking-widest hover:bg-slate-200 transition-all"
        >
          <Home size={18} /> Return to Homepage
        </button>

        {error && (
          <p className="text-center mt-6 text-[11px] text-slate-400">
            Transaction ID: {ref}
          </p>
        )}
      </div>

      <style jsx global>{`
        .font-outfit { font-family: 'Outfit', sans-serif; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    </div>
  );
}
