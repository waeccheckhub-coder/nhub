import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import toast, { Toaster } from 'react-hot-toast';
import axios from 'axios';
import { CheckCircle, Clock, AlertCircle } from 'lucide-react';

export default function Home() {
  const router = useRouter();
  const [hasMounted, setHasMounted] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [network, setNetwork] = useState('MTN');
  const [quantities, setQuantities] = useState({ WASSCE: 1, BECE: 1, CSSPS: 1 });
  const [retrieveInput, setRetrieveInput] = useState('');
  const [retrievedData, setRetrievedData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [payingFor, setPayingFor] = useState(null);
  const [stock, setStock] = useState({ WASSCE: 0, BECE: 0, CSSPS: 0 });
  const [prices, setPrices] = useState({ WASSCE: 30, BECE: 30, CSSPS: 30 });
  const [supportWhatsapp, setSupportWhatsapp] = useState('');
  const [allowPreorder, setAllowPreorder] = useState(false);

  useEffect(() => {
    setHasMounted(true);
    checkStock();
  }, []);

  const checkStock = async () => {
    try {
      const res = await axios.get('/api/public-stock');
      setStock(res.data.stock || res.data);
      if (res.data.prices) setPrices(res.data.prices);
      if (res.data.supportWhatsapp) setSupportWhatsapp(res.data.supportWhatsapp);
    } catch (e) { console.error('Stock check failed'); }
  };

  const initiatePayment = async (voucherType) => {
    if (!phone) return toast.error('Please enter your phone number');
    if (!name) return toast.error('Please enter your name');
    setPayingFor(voucherType);
    setLoading(true);

    const qty = quantities[voucherType];
    const isPreorder = stock[voucherType] <= 0;

    const t = toast.loading('Initializing payment...');
    try {
      const res = await axios.post('/api/init-payment', {
        phone, name, quantity: qty, type: voucherType, network
      });

      toast.dismiss(t);

      if (res.data.paymentUrl) {
        // Store order in localStorage (primary) — thank-you page reads this
        try {
          localStorage.setItem('pendingOrder', JSON.stringify({
            reference: res.data.reference, quantity: qty, type: voucherType, phone, name,
          }));
        } catch (_) {}
        // Also embed order details in the return URL as fallback for when localStorage is unavailable
        const base = res.data.paymentUrl;
        // The returnUrl is set server-side; Moolre appends the ref automatically.
        // We stash params in sessionStorage too as secondary fallback.
        try {
          sessionStorage.setItem('pendingOrder', JSON.stringify({
            reference: res.data.reference, quantity: qty, type: voucherType, phone, name,
          }));
        } catch (_) {}
        window.location.href = base;
      } else {
        toast.error('Could not initialize payment. Please try again.');
      }
    } catch (e) {
      toast.dismiss(t);
      toast.error(e?.response?.data?.error || 'Payment initialization failed');
    } finally {
      setLoading(false);
      setPayingFor(null);
    }
  };

  const retrieveVouchers = async () => {
    if (!retrieveInput) return toast.error('Please enter your phone number');
    setLoading(true);
    try {
      const res = await axios.post('/api/retrieve', { phone: retrieveInput });
      setRetrievedData(res.data);
      toast.success(`Found ${res.data.length} voucher(s)`);
    } catch (e) { toast.error('No vouchers found.'); }
    setLoading(false);
  };

  const VOUCHER_TYPES = [
    { id: 'WASSCE', label: 'WASSCE / NOVDEC', desc: 'Results Checker Voucher', color: 'from-violet-600 to-indigo-600' },
    { id: 'BECE', label: 'BECE Voucher', desc: 'Junior High School Results Checker', color: 'from-blue-600 to-cyan-500' },
    { id: 'CSSPS', label: 'School Placement (CSSPS)', desc: 'Senior High School Placement Voucher', color: 'from-emerald-600 to-teal-500' },
  ];

  return (
    <div className="min-h-screen aura-bg text-[#1e293b] font-outfit selection:bg-[#4f46e5] selection:text-white">
      <Head>
        <title>WAEC GH CHECKERS — Instant WASSCE, BECE & CSSPS Delivery</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Space+Grotesk:wght@700&display=swap" rel="stylesheet" />
      </Head>
      <Toaster position="top-center" />

      <div className="max-w-[1100px] mx-auto px-5 py-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center gap-6 mb-10">
          <div className="flex items-center gap-3">
            <div className="w-[46px] h-[46px] rounded-xl bg-gradient-to-br from-[#4f46e5] to-[#06b6d4] flex items-center justify-center text-white font-bold text-xl shadow-[0_4px_15px_rgba(79,70,229,0.3)] font-space">AC</div>
            <div>
              <div className="font-extrabold text-[17px]">WAEC GH CHECKERS</div>
              <div className="text-sm text-[#64748b]">Instant voucher delivery</div>
            </div>
          </div>
          <nav className="flex gap-5 flex-wrap justify-center">
            {['How it works', 'FAQ', 'Retrieve', 'Buy Now'].map((item) => (
              <a key={item} href={`#${item.toLowerCase().replace(/ /g, '')}`} className="text-[#64748b] font-semibold text-[15px] hover:text-[#4f46e5] transition-colors uppercase tracking-tight">{item}</a>
            ))}
          </nav>
        </header>

        {/* Hero */}
        <section className="text-center mb-12 pt-4">
          <h1 className="font-space text-4xl md:text-[48px] font-bold leading-[1.1] mb-4 tracking-[-1px]">
            Buy WASSCE, BECE & CSSPS <span className="text-[#4f46e5]">Instantly</span>
          </h1>
          <p className="text-[#64748b] text-lg mb-2">Authentic WAEC result checkers delivered via SMS. Pay with Mobile Money.</p>
          <p className="text-sm text-[#64748b]">Powered by <strong>Moolre</strong> — MTN MoMo, Telecel Cash, AT Money accepted</p>
        </section>

        {/* Shared Fields */}
        <div className="glass-card p-6 mb-6" id="buynow">
          <h3 className="font-bold text-[#4f46e5] mb-4 text-sm uppercase tracking-widest">Your Details (applies to all purchases)</h3>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="label">Full Name</label>
              <input value={name} onChange={e => setName(e.target.value)} className="input-field" placeholder="John Doe" />
            </div>
            <div>
              <label className="label">Phone Number (Mobile Money)</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} className="input-field" placeholder="0244123456" />
            </div>
            <div>
              <label className="label">Mobile Network</label>
              <select value={network} onChange={e => setNetwork(e.target.value)} className="input-field">
                <option value="MTN">MTN Mobile Money</option>
                <option value="TELECEL">Telecel Cash</option>
                <option value="AT">AT Money</option>
              </select>
            </div>
          </div>
        </div>

        {/* Voucher Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          {VOUCHER_TYPES.map((vt) => {
            const inStock = stock[vt.id] > 0;
            const isPreorder = !inStock;
            const price = prices[vt.id] || 30;
            const qty = quantities[vt.id];
            const isPaying = payingFor === vt.id && loading;

            return (
              <div key={vt.id} className={`glass-card p-6 flex flex-col relative overflow-hidden transition-all duration-300 ${!inStock && !allowPreorder ? 'opacity-75' : ''}`} id={`${vt.id}Form`}>
                {/* Stock badge */}
                {inStock ? (
                  <div className="flex items-center gap-1 text-emerald-600 text-[10px] font-black uppercase tracking-widest mb-3">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                    {stock[vt.id]} in stock
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-amber-600 text-[10px] font-black uppercase tracking-widest mb-3">
                    <Clock size={12} /> Pre-order available
                  </div>
                )}

                <h3 className={`text-lg font-bold mb-1 bg-gradient-to-r ${vt.color} bg-clip-text text-transparent`}>{vt.label}</h3>
                <p className="text-sm text-[#64748b] mb-4 flex-1">{vt.desc}</p>

                <div className="space-y-3">
                  <div>
                    <label className="label">Quantity</label>
                    <select className="input-field w-full" value={qty}
                      onChange={e => setQuantities({ ...quantities, [vt.id]: Number(e.target.value) })}>
                      {[...Array(10)].map((_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                    </select>
                  </div>

                  <div className="flex justify-between items-center text-sm text-[#64748b] font-semibold">
                    <span>Total:</span>
                    <span className="text-[#4f46e5] font-bold text-lg">GHS {price * qty}</span>
                  </div>

                  {isPreorder && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                      <div className="flex items-center gap-1 font-bold mb-1"><AlertCircle size={12} /> Out of Stock — Pre-Order</div>
                      Pay now. Your vouchers will be SMS'd when restocked.
                    </div>
                  )}

                  {hasMounted && (
                    <button
                      onClick={() => initiatePayment(vt.id)}
                      disabled={isPaying || loading}
                      className={`w-full py-4 rounded-[14px] font-bold transition-all text-white relative overflow-hidden
                        ${isPaying ? 'opacity-70 cursor-wait' : 'hover:-translate-y-0.5 active:translate-y-0'}
                        bg-gradient-to-br ${vt.color} shadow-lg`}
                    >
                      {isPaying ? 'Redirecting to Moolre...' : isPreorder ? `Pre-Order — Pay GHS ${price * qty}` : `Pay GHS ${price * qty} via Moolre`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Retrieve Section */}
        <section id="retrieve" className="glass-card p-8 mb-8">
          <h3 className="text-xl font-bold mb-1">Retrieve Purchased Vouchers</h3>
          <p className="text-sm text-[#64748b] mb-6">Enter the phone number you used to purchase.</p>
          <div className="flex flex-col md:flex-row gap-3">
            <input value={retrieveInput} onChange={e => setRetrieveInput(e.target.value)}
              className="input-field flex-1" placeholder="0244123456" />
            <button onClick={retrieveVouchers} disabled={loading}
              className="bg-gradient-to-br from-[#4f46e5] to-[#06b6d4] text-white px-8 py-3 rounded-[14px] font-bold transition-all disabled:opacity-50">
              {loading ? 'Searching...' : 'Retrieve'}
            </button>
          </div>
          {retrievedData && (
            <div className="mt-6 space-y-2 p-4 rounded-2xl bg-white/50 border border-dashed border-[#4f46e5]">
              {retrievedData.length === 0 ? (
                <p className="text-sm text-[#64748b]">No vouchers found for this number.</p>
              ) : retrievedData.map((v, i) => (
                <div key={i} className="p-3 bg-white rounded-lg border border-[#e2e8f0] font-space text-sm flex justify-between">
                  <span>{v.type} — {v.serial}</span>
                  <span className="font-bold text-[#4f46e5]">{v.pin}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Info */}
        <div className="grid md:grid-cols-2 gap-6">
          <section id="howitworks" className="glass-card p-6">
            <h3 className="font-bold mb-3">How it works</h3>
            <ol className="text-sm text-[#64748b] space-y-2 ml-4 list-decimal">
              <li>Fill your details above and click "Pay via Moolre".</li>
              <li>You'll be redirected to Moolre's secure page — pay with MoMo, Telecel, or AT Money.</li>
              <li>After payment, voucher(s) are delivered instantly via SMS.</li>
              <li>Out of stock? Pre-order and receive when restocked!</li>
            </ol>
          </section>
          <section id="faq" className="glass-card p-6">
            <h3 className="font-bold mb-3">FAQ</h3>
            <div className="text-sm text-[#64748b] space-y-2">
              <p><strong>Delivery Time:</strong> Instant after payment confirmation.</p>
              <p><strong>Payment Methods:</strong> MTN MoMo, Telecel Cash, AT Money via Moolre.</p>
              <p><strong>Didn't receive SMS?</strong> Use the Retrieve section above with your phone number.</p>
              <p><strong>Out of stock?</strong> Pre-order — you'll get vouchers as soon as they're uploaded!</p>
            </div>
          </section>
        </div>

        <footer className="text-center py-10 text-[#64748b] text-sm font-medium">
          {supportWhatsapp && (
            <a
              href={`https://wa.me/${supportWhatsapp.replace(/[^0-9]/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 mb-6 bg-[#25D366] text-white px-6 py-3 rounded-full font-bold text-sm shadow-lg hover:bg-[#20b858] transition-all"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              Chat with Support on WhatsApp
            </a>
          )}
          © 2025 WAEC GH Cards Online. Securely Powered by <strong>Moolre</strong>.
        </footer>
      </div>

      <style jsx global>{`
        .aura-bg {
          background: #f4f7fc;
          background-image:
            radial-gradient(at 0% 0%, rgba(6, 182, 212, 0.15) 0px, transparent 50%),
            radial-gradient(at 100% 100%, rgba(79, 70, 229, 0.15) 0px, transparent 50%);
        }
        .glass-card {
          background: rgba(255, 255, 255, 0.7);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid #ffffff;
          border-radius: 24px;
          box-shadow: 0 10px 30px -10px rgba(79, 70, 229, 0.15);
        }
        .label { display: block; margin-bottom: 6px; font-weight: 700; font-size: 13px; color: #4f46e5; }
        .input-field {
          width: 100%; padding: 12px 14px; border-radius: 12px;
          border: 2px solid #e2e8f0; background: #ffffff; font-size: 14px; transition: 0.3s; outline: none;
        }
        .input-field:focus { border-color: #4f46e5; box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.1); }
        .font-outfit { font-family: 'Outfit', sans-serif; }
        .font-space { font-family: 'Space Grotesk', sans-serif; }
      `}</style>
    </div>
  );
}
