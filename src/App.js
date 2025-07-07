import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, addDoc, onSnapshot, query, deleteDoc, getDocs } from 'firebase/firestore';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// --- Helper Functions ---
const debounce = (func, delay) => {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
};

// --- Points Calculation Logic ---
const calculatePoints = (item) => {
    if (item.isZeroPoint) {
        return 0;
    }
    const p = parseFloat(item.protein) || 0;
    const c = parseFloat(item.carbs) || 0;
    const f = parseFloat(item.fat) || 0;
    const fi = parseFloat(item.fiber) || 0;
    const cal = parseFloat(item.calories) || ((p * 4) + (c * 4) + (f * 9));
    const qty = parseFloat(item.quantity) || 1;

    const pointsPerUnit = (cal / 33) + (f / 9) - (Math.min(fi, c / 10) / 5);
    
    const totalPoints = pointsPerUnit * qty;

    return Math.max(0, Math.round(totalPoints));
};

// --- Modal Component ---
const Modal = ({ isOpen, onClose, title, children }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md m-4">
                <div className="flex justify-between items-center p-4 border-b">
                    <h3 className="text-xl font-semibold text-gray-800">{title}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div className="p-6 max-h-[60vh] overflow-y-auto">
                    {children}
                </div>
            </div>
        </div>
    );
};


// --- Main App Component ---
export default function App() {
    // --- Firebase State ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // --- App State ---
    const [foodLog, setFoodLog] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [isFetching, setIsFetching] = useState(false);
    const [lookupSuccess, setLookupSuccess] = useState(false);
    
    // --- Gemini Features State ---
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalContent, setModalContent] = useState({ title: '', content: null });
    const [isGenerating, setIsGenerating] = useState(false);


    // --- Form State ---
    const [foodName, setFoodName] = useState('');
    const [protein, setProtein] = useState('');
    const [carbs, setCarbs] = useState('');
    const [fat, setFat] = useState('');
    const [fiber, setFiber] = useState('');
    const [calories, setCalories] = useState('');
    const [quantity, setQuantity] = useState(1);
    const [unit, setUnit] = useState('serving');
    const [isZeroPoint, setIsZeroPoint] = useState(false);

    // --- Firebase Initialization and Auth ---
    useEffect(() => {
        try {
            const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);
            
            setDb(firestoreDb);
            setAuth(firebaseAuth);

            onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    try {
                         if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                            await signInWithCustomToken(firebaseAuth, __initial_auth_token);
                         } else {
                            await signInAnonymously(firebaseAuth);
                         }
                    } catch (authError) {
                        console.error("Authentication failed:", authError);
                        setError("Could not connect to the database. Please refresh.");
                    }
                }
                setIsAuthReady(true);
            });
        } catch (e) {
            console.error("Firebase initialization error:", e);
            setError("There was a problem loading the application. Please try again later.");
            setIsLoading(false);
        }
    }, []);

    // --- Firestore Data Listener ---
    useEffect(() => {
        if (isAuthReady && db && userId) {
            setIsLoading(true);
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            const foodLogCollectionPath = `/artifacts/${appId}/users/${userId}/foodLog`;
            const q = query(collection(db, foodLogCollectionPath));

            const unsubscribe = onSnapshot(q, (querySnapshot) => {
                const log = [];
                querySnapshot.forEach((doc) => {
                    log.push({ id: doc.id, ...doc.data() });
                });
                setFoodLog(log);
                setIsLoading(false);
            }, (err) => {
                console.error("Firestore snapshot error:", err);
                setError("Failed to load food log. Please check your connection.");
                setIsLoading(false);
            });

            return () => unsubscribe();
        }
    }, [isAuthReady, db, userId]);
    
    const resetNutrientFields = () => {
        setProtein(''); setCarbs(''); setFat(''); setFiber(''); setCalories('');
        setIsZeroPoint(false); setLookupSuccess(false); setError('');
    };
    
    useEffect(resetNutrientFields, [foodName]);

    // --- Gemini API Call for Nutrient Lookup ---
    const handleFoodLookup = async () => {
        if (!foodName.trim()) { setError("Please enter a food name."); return; }
        setIsFetching(true); resetNutrientFields();
        const prompt = `Based on general Weight Watchers principles, provide the nutritional information for one single '${unit}' of '${foodName}'. Include calories. Determine if it's a zero-point food. Respond ONLY with a JSON object.`;
        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "calories": { "type": "NUMBER" },
                        "protein": { "type": "NUMBER" }, "carbs": { "type": "NUMBER" },
                        "fat": { "type": "NUMBER" }, "fiber": { "type": "NUMBER" },
                        "isZeroPoint": { "type": "BOOLEAN" }
                    },
                    required: ["calories", "protein", "carbs", "fat", "fiber", "isZeroPoint"]
                }
            }
        };
        try {
            const apiKey = "";
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
            const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                const data = JSON.parse(result.candidates[0].content.parts[0].text);
                setCalories(data.calories.toString());
                setProtein(data.protein.toString()); setCarbs(data.carbs.toString());
                setFat(data.fat.toString()); setFiber(data.fiber.toString());
                setIsZeroPoint(data.isZeroPoint); setLookupSuccess(true);
            } else { throw new Error("Could not find nutritional data."); }
        } catch (err) {
            console.error("Gemini API error:", err);
            setError(err.message || "Failed to fetch data.");
            setLookupSuccess(false);
        } finally { setIsFetching(false); }
    };
    
    const handleSuggestMeal = async (mealType) => {
        if (!mealType) return;
        const pointRanges = { "Snack": "1-4 points", "Breakfast": "4-8 points", "Lunch": "8-12 points", "Dinner": "10-15 points" };
        const targetPoints = pointRanges[mealType];
        const prompt = `I'm on a Weight Watchers-style points system. Suggest 3 diverse and simple ${mealType.toLowerCase()} ideas that are in the ${targetPoints} range. For each suggestion, provide a name and a brief, appealing description. Respond ONLY with a JSON object containing an array called "suggestions".`;
        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT", properties: { "suggestions": { type: "ARRAY", items: { type: "OBJECT", properties: { "name": { "type": "STRING" }, "description": { "type": "STRING" } }, required: ["name", "description"] } } }
                }
            }
        };
        setIsGenerating(true);
        setModalContent({ title: `Suggesting a ${mealType}...`, content: <p>Thinking of some tasty ideas...</p> });
        setIsModalOpen(true);
        try {
            const apiKey = "";
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
            const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`API request failed: ${response.status}`);
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                const data = JSON.parse(result.candidates[0].content.parts[0].text);
                const suggestionContent = (<ul className="space-y-4">{data.suggestions.map((s, i) => (<li key={i} className="p-3 bg-gray-50 rounded-lg"><p className="font-bold text-indigo-700">{s.name}</p><p className="text-gray-600 text-sm">{s.description}</p></li>))}</ul>);
                setModalContent({ title: `${mealType} Suggestions`, content: suggestionContent });
            } else { throw new Error("Could not generate suggestions."); }
        } catch (err) { setModalContent({ title: "Error", content: <p className="text-red-500">{err.message}</p> });
        } finally { setIsGenerating(false); }
    };
    
    const handleAnalyzeDay = async () => {
        if (foodLog.length === 0) { setError("Log at least one food item to get an analysis."); return; }
        const logSummary = foodLog.map(item => `${item.quantity} ${item.unit} of ${item.name} (${calculatePoints(item)} points)`).join(', ');
        const prompt = `I am on a Weight Watchers-style points system. My total points today are ${totalPoints}. My food log contains: ${logSummary}. Provide a brief, encouraging analysis of my day's eating. Comment on the balance of my meals and my total points. Offer one positive, actionable suggestion for tomorrow. Keep the tone friendly. Respond with simple text, using markdown for formatting.`;
        setIsGenerating(true);
        setModalContent({ title: "Analyzing Your Day...", content: <p>Reviewing your log...</p> });
        setIsModalOpen(true);
        try {
            const apiKey = "";
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
            const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }) });
            if (!response.ok) throw new Error(`API request failed: ${response.status}`);
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                const analysisText = result.candidates[0].content.parts[0].text.replace(/\n/g, '<br />');
                setModalContent({ title: "Your Daily Analysis", content: <div className="text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: analysisText }} /> });
            } else { throw new Error("Could not generate analysis."); }
        } catch (err) { setModalContent({ title: "Error", content: <p className="text-red-500">{err.message}</p> });
        } finally { setIsGenerating(false); }
    };

    const previewPoints = useMemo(() => {
        const item = { protein, carbs, fat, fiber, calories, quantity, isZeroPoint };
        return calculatePoints(item);
    }, [protein, carbs, fat, fiber, calories, quantity, isZeroPoint]);

    const totalPoints = useMemo(() => foodLog.reduce((total, item) => total + calculatePoints(item), 0), [foodLog]);

    const handleAddFood = async (e) => {
        e.preventDefault();
        if (!lookupSuccess) { setError("Please look up a food item first."); return; }
        if (!db || !userId) { setError("Database not connected."); return; }
        const newFood = { name: foodName, calories: parseFloat(calories), protein: parseFloat(protein), carbs: parseFloat(carbs), fat: parseFloat(fat), fiber: parseFloat(fiber), quantity: parseFloat(quantity), unit, isZeroPoint, createdAt: new Date() };
        try {
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            await addDoc(collection(db, `/artifacts/${appId}/users/${userId}/foodLog`), newFood);
            setFoodName(''); resetNutrientFields(); setQuantity(1); setUnit('serving');
        } catch (err) { console.error("Error adding document: ", err); setError("Failed to save food item."); }
    };

    const handleDeleteFood = async (foodId) => {
        if (!db || !userId) { setError("Database not connected."); return; }
        try {
            const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
            await deleteDoc(doc(db, `/artifacts/${appId}/users/${userId}/foodLog/${foodId}`));
        } catch (err) { console.error("Error deleting document: ", err); setError("Failed to delete food item."); }
    };
    
    const handleClearLog = async () => {
        if (!db || !userId) { setError("Database not connected."); return; }
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const foodLogCollectionPath = `/artifacts/${appId}/users/${userId}/foodLog`;
        const q = query(collection(db, foodLogCollectionPath));
        const querySnapshot = await getDocs(q);
        querySnapshot.forEach(async (document) => {
            try { await deleteDoc(doc(db, foodLogCollectionPath, document.id)); } catch (err) { console.error("Error clearing log item:", err); setError("Failed to clear entire log."); }
        });
    };

    const debouncedSetError = useMemo(() => debounce(setError, 5000), []);
    useEffect(() => { if (error) { debouncedSetError(''); } }, [error, debouncedSetError]);

    // --- Render ---
    return (
        <div className="bg-gray-50 min-h-screen font-sans text-gray-800 antialiased">
            <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={modalContent.title}>
                {modalContent.content}
            </Modal>
            <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-4xl">
                <header className="text-center mb-8">
                    <h1 className="text-4xl sm:text-5xl font-bold text-blue-600">Smart Points Tracker</h1>
                    <p className="text-gray-500 mt-2">Your AI-powered daily food logging assistant.</p>
                </header>

                {error && <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded-md shadow-sm" role="alert"><p>{error}</p></div>}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-1 space-y-8">
                        <div className="bg-white p-6 rounded-2xl shadow-lg">
                            <h2 className="text-2xl font-semibold mb-4 border-b pb-3 text-gray-700">Log a Food Item</h2>
                            <form onSubmit={handleAddFood} className="space-y-4">
                                <input type="text" placeholder="Food Name (e.g., 'banana')" value={foodName} onChange={(e) => setFoodName(e.target.value)} className="w-full p-3 bg-gray-100 rounded-lg border focus:ring-2 focus:ring-blue-500" />
                                <div className="flex gap-3">
                                    <input type="number" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} min="0.01" step="0.01" className="w-1/3 p-3 bg-gray-100 rounded-lg border focus:ring-2 focus:ring-blue-500" />
                                    <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-2/3 p-3 bg-gray-100 rounded-lg border focus:ring-2 focus:ring-blue-500">
                                        <option>serving</option><option>item</option><option>g</option><option>oz</option><option>lb</option><option>cup</option><option>TBSP</option><option>TSP</option><option>slice</option>
                                    </select>
                                </div>
                                <button type="button" onClick={handleFoodLookup} disabled={isFetching || !foodName.trim()} className="w-full bg-indigo-600 text-white font-bold py-3 rounded-lg hover:bg-indigo-700 transition shadow-md disabled:bg-indigo-300">
                                    {isFetching ? 'Looking up...' : 'Look Up Food'}
                                </button>
                                <div className={`p-4 rounded-lg transition-all ${lookupSuccess ? 'bg-green-50' : 'bg-gray-50'}`}>
                                    <p className="text-sm text-gray-500 mb-3">Nutritional Info (per unit):</p>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex justify-between items-center bg-white p-2 rounded-md"><span className="font-medium text-gray-600">Calories</span><span className="font-bold text-gray-800">{calories || '...'}</span></div>
                                        <div className="flex justify-between items-center bg-white p-2 rounded-md"><span className="font-medium text-gray-600">Protein</span><span className="font-bold text-gray-800">{protein || '...'} g</span></div>
                                        <div className="flex justify-between items-center bg-white p-2 rounded-md"><span className="font-medium text-gray-600">Carbs</span><span className="font-bold text-gray-800">{carbs || '...'} g</span></div>
                                        <div className="flex justify-between items-center bg-white p-2 rounded-md"><span className="font-medium text-gray-600">Fat</span><span className="font-bold text-gray-800">{fat || '...'} g</span></div>
                                        <div className="flex justify-between items-center bg-white p-2 rounded-md"><span className="font-medium text-gray-600">Fiber</span><span className="font-bold text-gray-800">{fiber || '...'} g</span></div>
                                    </div>
                                    {lookupSuccess && <p className={`mt-3 text-center font-semibold rounded-md p-2 ${isZeroPoint ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>{isZeroPoint ? 'Zero-Point Food!' : 'This food has points.'}</p>}
                                </div>
                                
                                {lookupSuccess && (
                                    <div className="border-t pt-4 mt-4">
                                        <p className="text-center font-semibold text-gray-600 mb-2">Log Preview</p>
                                        <div className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border">
                                            <div>
                                                <p className="font-bold text-lg text-gray-800">{foodName}</p>
                                                <p className="text-sm text-gray-600 font-medium">{quantity} {unit}</p>
                                            </div>
                                            <span className={`text-xl font-bold px-3 py-1 rounded-full ${isZeroPoint ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{previewPoints}</span>
                                        </div>
                                    </div>
                                )}
                                
                                <button type="submit" disabled={!lookupSuccess || isFetching} className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition shadow-md disabled:bg-blue-300">Add to Log</button>
                            </form>
                        </div>
                        
                        <div className="bg-white p-6 rounded-2xl shadow-lg space-y-4">
                            <h2 className="text-2xl font-semibold text-center text-gray-700">AI Assistant</h2>
                            <div className="space-y-3">
                                <button onClick={() => handleSuggestMeal(prompt("What meal are you looking for? (Breakfast, Lunch, Dinner, Snack)"))} disabled={isGenerating} className="w-full flex items-center justify-center gap-2 bg-purple-600 text-white font-bold py-3 rounded-lg hover:bg-purple-700 transition shadow-md disabled:bg-purple-300">✨ Suggest a Meal</button>
                                <button onClick={handleAnalyzeDay} disabled={isGenerating || foodLog.length === 0} className="w-full flex items-center justify-center gap-2 bg-teal-500 text-white font-bold py-3 rounded-lg hover:bg-teal-600 transition shadow-md disabled:bg-teal-300">✨ Analyze My Day</button>
                            </div>
                        </div>

                        <div className="bg-white p-6 rounded-2xl shadow-lg text-center">
                             <h2 className="text-2xl font-semibold mb-2 text-gray-700">Total Points Today</h2>
                             <p className="text-5xl font-bold text-blue-600">{totalPoints}</p>
                        </div>
                    </div>

                    <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-lg">
                        <div className="flex justify-between items-center border-b pb-3 mb-4">
                            <h2 className="text-2xl font-semibold text-gray-700">Today's Log</h2>
                            <button onClick={handleClearLog} className="text-sm text-red-500 hover:text-red-700 font-semibold transition disabled:opacity-50" disabled={foodLog.length === 0}>Clear All</button>
                        </div>
                        <div className="space-y-3 max-h-[75vh] overflow-y-auto pr-2">
                            {isLoading ? <p className="text-center text-gray-500 py-8">Loading your log...</p> : foodLog.length === 0 ? (
                                <div className="text-center py-10 px-4 bg-gray-50 rounded-lg"><p className="text-gray-500">Your food log is empty.</p><p className="text-sm text-gray-400 mt-1">Look up a food item to get started!</p></div>
                            ) : (
                                foodLog.slice().sort((a, b) => new Date(b.createdAt?.toDate()) - new Date(a.createdAt?.toDate())).map(item => (
                                    <div key={item.id} className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border hover:shadow-md transition-shadow">
                                        <div>
                                            <p className="font-bold text-lg text-gray-800">{item.name}</p>
                                            <p className="text-sm text-gray-600 font-medium">{item.quantity} {item.unit}</p>
                                            <p className="text-xs text-gray-500 mt-1">
                                                Cal: {item.calories} | P: {item.protein}g | C: {item.carbs}g | F: {item.fat}g | Fb: {item.fiber}g
                                            </p>
                                        </div>
                                        <div className="flex items-center space-x-4">
                                            <span className={`text-xl font-bold px-3 py-1 rounded-full ${item.isZeroPoint ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{calculatePoints(item)}</span>
                                            <button onClick={() => handleDeleteFood(item.id)} className="text-gray-400 hover:text-red-500 transition">
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
                 <footer className="text-center mt-8 text-sm text-gray-400">
                    <p>User ID: <span className="font-mono bg-gray-200 px-1 rounded">{userId || 'Connecting...'}</span></p>
                    <p className="mt-2">Disclaimer: This is a tool for theoretical point estimation. Nutritional data and AI suggestions are provided for informational purposes and may not be 100% accurate.</p>
                </footer>
            </div>
        </div>
    );
}
