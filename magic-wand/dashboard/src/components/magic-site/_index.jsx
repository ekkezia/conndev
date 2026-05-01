import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";

function goTo(path) {
  window.location.pathname = path;
}

const STORE_PRODUCTS = [
  {
    id: "magic-wand-v4",
    name: "MagicWand v4",
    price: 129,
    description: "Gesture wand controller with sensitivity, click, and draw start/stop controls.",
    image: "/images/magic-wand-product.png",
  },
  {
    id: "magic-wand-glitter",
    name: "MagicWand™ Glitter Edition",
    price: 149,
    description: "The same beloved wand core with a sparkly finish and premium gift-ready packaging.",
    image: "/images/magic-wand-product.png",
  },
];

export default function MagicSuiteLanding() {
  const heroVideoRef = useRef(null);
  const [heroSoundOn, setHeroSoundOn] = useState(false);
  const [cart, setCart] = useState({});
  const [checkout, setCheckout] = useState({
    name: "",
    email: "",
    address: "",
    payment: "card",
  });
  const [orderPlaced, setOrderPlaced] = useState(false);

  const holdLastFrame = () => {
    const video = heroVideoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.pause();
    video.currentTime = Math.max(0, video.duration - 0.01);
  };

  const replayOnHover = async () => {
    const video = heroVideoRef.current;
    if (!video) return;
    video.currentTime = 0;
    try {
      await video.play();
    } catch (err) {
      // Ignore play errors from browser autoplay restrictions.
    }
  };

  const cartItems = useMemo(() => {
    return STORE_PRODUCTS.filter((product) => cart[product.id] > 0).map((product) => ({
      ...product,
      qty: cart[product.id],
      total: cart[product.id] * product.price,
    }));
  }, [cart]);

  const subtotal = useMemo(() => cartItems.reduce((sum, item) => sum + item.total, 0), [cartItems]);
  const shipping = subtotal > 0 ? 12 : 0;
  const total = subtotal + shipping;

  const addToCart = (productId) => {
    setOrderPlaced(false);
    setCart((prev) => ({ ...prev, [productId]: (prev[productId] || 0) + 1 }));
  };

  const updateQty = (productId, nextQty) => {
    setOrderPlaced(false);
    setCart((prev) => {
      if (nextQty <= 0) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return { ...prev, [productId]: nextQty };
    });
  };

  const handleCheckoutField = (event) => {
    const { name, value } = event.target;
    setCheckout((prev) => ({ ...prev, [name]: value }));
  };

  const placeOrder = (event) => {
    event.preventDefault();
    if (!checkout.name || !checkout.email || !checkout.address || cartItems.length === 0) return;
    setOrderPlaced(true);
    setCart({});
  };

  useEffect(() => {
    const video = heroVideoRef.current;
    if (!video) return undefined;

    const ensurePlay = () => {
      video.play().catch(() => {});
    };

    ensurePlay();
    video.addEventListener("loadeddata", ensurePlay);
    video.addEventListener("canplay", ensurePlay);

    return () => {
      video.removeEventListener("loadeddata", ensurePlay);
      video.removeEventListener("canplay", ensurePlay);
    };
  }, []);

  useEffect(() => {
    if (heroSoundOn) return undefined;

    const enableSoundFromGesture = async () => {
      const video = heroVideoRef.current;
      if (!video) return;
      setHeroSoundOn(true);
      video.muted = false;
      video.volume = 1;
      try {
        await video.play();
      } catch (err) {
        // Ignore play errors if browser still blocks playback.
      }
    };

    window.addEventListener("pointerdown", enableSoundFromGesture, { once: true });
    window.addEventListener("keydown", enableSoundFromGesture, { once: true });

    return () => {
      window.removeEventListener("pointerdown", enableSoundFromGesture);
      window.removeEventListener("keydown", enableSoundFromGesture);
    };
  }, [heroSoundOn]);

  return (
    <div className="ms-page">
      <div className="ms-bg-float" aria-hidden="true">
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
        <span className="ms-float-item ms-float-star">★</span>
        <span className="ms-float-item ms-float-heart">♥</span>
      </div>

      <header className="ms-nav-shell">
        <nav className="ms-nav">
          <a className="ms-brand" href="#top">
            <div className="ms-logo-placeholder">⭐</div>
            <span>MagicSuite™</span>
          </a>
          <div className="ms-menu">
            <a href="#store">Store</a>
            <a href="#magicwand">MagicWand™</a>
            <a href="#lilcam">LilCam</a>
            <a href="#support">Support</a>
          </div>
        </nav>
      </header>

      <section id="top" className="ms-hero">
        <div className="ms-hero-video-shell">
          <video
            ref={heroVideoRef}
            className="ms-hero-video"
            src="/video/hero.mp4"
            autoPlay
            muted={!heroSoundOn}
            playsInline
            preload="auto"
            onEnded={holdLastFrame}
            onMouseEnter={replayOnHover}
          />
        </div>
        <div className="ms-hero-overlay" />
        <div className="ms-hero-copy">
          <p className="ms-eyebrow">The newest addition to MagicSuite™ Family</p>
          <h1>MagicWand™</h1>
          <p className="ms-subcopy">
            Sensitivity, click, and draw start/stop controls in one playful gesture wand.
          </p>
          <div className="ms-cta-row">
            <button type="button" className="ms-btn ms-btn-primary ms-btn-magicbeats" onClick={() => goTo("/magicbeats")}>
              MagicBeats
            </button>
            <button type="button" className="ms-btn ms-btn-secondary ms-btn-magiccanvas" onClick={() => goTo("/magiccanvas")}>
              MagicCanvas
            </button>
          </div>
        </div>
      </section>

      <main className="ms-main">
        <section className="ms-section-card ms-intro-card">
          <h2>MagicSuite™. Magic happens in your hand.</h2>
          <p className="ms-summary">
            Interactive devices that turn movement and place into playful, embodied computing.
          </p>
        </section>
        
        <section id="magicwand" className="ms-section-card">
          <h2>MagicWand™</h2>
          <p className="ms-summary">
            Magic Wand is a wireless device that turns physical gestures into mouse control, demonstrated
            through a rhythm game where users swing to hit beats while navigating an immersive, map-based
            visual journey.
          </p>
          <div className="ms-wand-showcase" aria-label="MagicWand controls">
            <div className="ms-wand-image-wrap">
              <img
                className="ms-wand-image"
                src="/images/magic-wand-product.png"
                alt="MagicWand with star top and control buttons"
              />
              <div className="ms-wand-indicators" aria-hidden="true">
                <motion.div
                  className="ms-wand-indicator ms-wand-indicator-sensitivity"
                  animate={{ x: [0, 8, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                >
                  <motion.span
                    className="ms-wand-dot"
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.span
                    className="ms-wand-line"
                    animate={{ scaleX: [0.65, 1, 0.8] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <span className="ms-wand-tag ms-wand-tag-sensitivity">SENSITIVITY</span>
                </motion.div>

                <motion.div
                  className="ms-wand-indicator ms-wand-indicator-click"
                  animate={{ x: [0, 8, 0] }}
                  transition={{ duration: 3, delay: 0.35, repeat: Infinity, ease: "easeInOut" }}
                >
                  <motion.span
                    className="ms-wand-dot"
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 1.4, delay: 0.25, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.span
                    className="ms-wand-line"
                    animate={{ scaleX: [0.65, 1, 0.8] }}
                    transition={{ duration: 1.6, delay: 0.25, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <span className="ms-wand-tag ms-wand-tag-click">CLICK</span>
                </motion.div>

                <motion.div
                  className="ms-wand-indicator ms-wand-indicator-draw"
                  animate={{ x: [0, 8, 0] }}
                  transition={{ duration: 3, delay: 0.65, repeat: Infinity, ease: "easeInOut" }}
                >
                  <motion.span
                    className="ms-wand-dot"
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 1.4, delay: 0.5, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.span
                    className="ms-wand-line"
                    animate={{ scaleX: [0.65, 1, 0.8] }}
                    transition={{ duration: 1.6, delay: 0.5, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <span className="ms-wand-tag ms-wand-tag-draw">DRAW START / STOP</span>
                </motion.div>
              </div>
            </div>
          </div>
          <p>
            Magic Wand transfers computer-native movement such as mouse position into an embodied one.
            In this demo, users swing the wand toward beats in time with music to score, while moving
            through a funky sequence of satellite street imagery.
          </p>
          <h3>How It Works Technically</h3>
          <p>
            Uses an IMU module (gyroscope + accelerometer) to approximate mouse location on screen.
            Sensor data travels from Arduino to a web server via UDP, then gets processed into cursor
            position. The server also generates random beats synced to playing music and fetches Mapillary
            API imagery for the game background as the user plays.
          </p>
          <h3>How People Engage</h3>
          <ol>
            <li>User picks up the wand and switches power on.</li>
            <li>Press START/STOP to activate the wand, with LED indicators lighting up.</li>
            <li>User selects a song with the wand.</li>
            <li>User swings toward beats in time to score magic.</li>
          </ol>
        </section>

        <section id="magicbeats" className="ms-section-card">
          <h2>MagicBeats</h2>
          <p className="ms-summary">
            Rhythm gameplay powered by wand gestures, where movement becomes timing, score, and flow.
          </p>
          <div className="ms-beats-media-wrap">
            <video className="ms-beats-media" src="/images/magic-beats.mov" autoPlay loop muted playsInline />
          </div>
        </section>

        <section id="lilcam" className="ms-section-card">
          <h2>LilCam</h2>
          <p className="ms-summary">
            A mini device that returns images from the nearest traffic camera to the user&apos;s current
            location and allows capture + save of those images.
          </p>
          <h3>Technical Snapshot</h3>
          <p>
            Material: PLA. Processor: XIAO ESP32S3 or ESP32C6. GPS module: Adafruit GPS Breakout v3.
            Networking: UDP. Power: internal rechargeable 9V battery.
          </p>
          <p>
            Public API source: <code>webcams.tmcnyc.org</code>. Endpoints:
            <code> /api/cameras</code> and <code> /api/cameras/[id]/image</code>.
          </p>
          <h3>Usage</h3>
          <ol>
            <li>Bring device outdoors so GPS can lock location.</li>
            <li>Power on to load nearest five traffic camera feeds.</li>
            <li>Rotate the encoder to scroll cameras.</li>
            <li>Press encoder to refresh current camera footage.</li>
            <li>Press capture to save current camera image internally.</li>
          </ol>
        </section>

        <section id="store" className="ms-section-card">
          <h2>Store</h2>
          <p>Buy MagicWand™ directly and checkout below.</p>
          <div className="ms-store-grid">
            <div className="ms-store-products">
              {STORE_PRODUCTS.map((product) => (
                <article className="ms-store-card" key={product.id}>
                  <img className="ms-store-image" src={product.image} alt={product.name} />
                  <div className="ms-store-meta">
                    <h3>{product.name}</h3>
                    <p>{product.description}</p>
                  </div>
                  <div className="ms-store-buy-row">
                    <strong>${product.price}</strong>
                    <button type="button" className="ms-btn ms-btn-primary" onClick={() => addToCart(product.id)}>
                      Add To Cart
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <aside className="ms-cart-panel" aria-live="polite">
              <h3>Cart</h3>
              {cartItems.length === 0 ? (
                <p className="ms-cart-empty">Your cart is empty.</p>
              ) : (
                <>
                  <ul className="ms-cart-list">
                    {cartItems.map((item) => (
                      <li key={item.id} className="ms-cart-item">
                        <div>
                          <strong>{item.name}</strong>
                          <p>${item.price} each</p>
                        </div>
                        <div className="ms-qty-controls">
                          <button type="button" onClick={() => updateQty(item.id, item.qty - 1)}>
                            -
                          </button>
                          <span>{item.qty}</span>
                          <button type="button" onClick={() => updateQty(item.id, item.qty + 1)}>
                            +
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="ms-cart-totals">
                    <p>
                      <span>Subtotal</span>
                      <strong>${subtotal}</strong>
                    </p>
                    <p>
                      <span>Shipping</span>
                      <strong>${shipping}</strong>
                    </p>
                    <p className="ms-cart-total-line">
                      <span>Total</span>
                      <strong>${total}</strong>
                    </p>
                  </div>
                </>
              )}
            </aside>
          </div>

          <form className="ms-checkout" onSubmit={placeOrder}>
            <h3>Checkout</h3>
            <div className="ms-checkout-grid">
              <label>
                Full Name
                <input name="name" value={checkout.name} onChange={handleCheckoutField} required />
              </label>
              <label>
                Email
                <input type="email" name="email" value={checkout.email} onChange={handleCheckoutField} required />
              </label>
              <label className="ms-checkout-address">
                Shipping Address
                <input name="address" value={checkout.address} onChange={handleCheckoutField} required />
              </label>
              <label>
                Payment
                <select name="payment" value={checkout.payment} onChange={handleCheckoutField}>
                  <option value="card">Card</option>
                  <option value="apple-pay">Apple Pay</option>
                  <option value="paypal">PayPal</option>
                </select>
              </label>
            </div>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={cartItems.length === 0}>
              Place Order
            </button>
            {orderPlaced && (
              <p className="ms-checkout-success">
                Order placed. Confirmation sent to {checkout.email}.
              </p>
            )}
          </form>
        </section>

        <section id="support" className="ms-section-card">
          <h2>Support</h2>
          <p>Need setup help, firmware updates, or demo troubleshooting? Support details placeholder.</p>
        </section>
      </main>
    </div>
  );
}
