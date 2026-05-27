import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, where, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
// ADDED: Firebase Authentication methods
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCfvDkaVXt9nVFzeAnWVoC5q3iZ7_CMGJg",
  authDomain: "smart-todo-app-5fcca.firebaseapp.com",
  projectId: "smart-todo-app-5fcca",
  storageBucket: "smart-todo-app-5fcca.firebasestorage.app",
  messagingSenderId: "254079310651",
  appId: "1:254079310651:web:5450581ad51efaf965351e"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app); // ADDED: Initialize Authentication Engine

const playedAlerts = new Set();
const dismissedAlerts = new Set(); 
let itemPendingDeletion = null; 
let activelyRingingAudio = null; 
let currentRingingTaskId = null; 
let localTasksArray = []; 
let unsubscribeSnapshot = null; // Stores the real-time sync unbind listener

const bootstrapDeleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
const bootstrapAlarmModal = new bootstrap.Modal(document.getElementById('alarmModal'));

if (Notification.permission !== "granted") {
    Notification.requestPermission();
}

// ================= COORDNATING LOGIC DOM TARGETS =================
const authSection = document.getElementById('authSection');
const mainAppSection = document.getElementById('mainAppSection');
const authForm = document.getElementById('authForm');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const toggleAuthAction = document.getElementById('toggleAuthAction');
const logoutBtn = document.getElementById('logoutBtn');

const taskForm = document.getElementById('taskForm');
const taskList = document.getElementById('taskList');
const notificationArea = document.getElementById('notificationArea');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const dismissAlarmBtn = document.getElementById('dismissAlarmBtn');

let isLoginMode = true; // Flag for toggling Login vs Register forms

// GLOBAL AUDIO ENGINE UNLOCKER
document.addEventListener('click', () => {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') {
        context.resume();
    }
}, { once: true });

// ================= USER SESSION MANAGEMENT =================

// Toggle UI text states between Login and Registration views
toggleAuthAction.addEventListener('click', (e) => {
    e.preventDefault();
    isLoginMode = !isLoginMode;
    if (isLoginMode) {
        document.getElementById('authCardTitle').innerText = "Sign In";
        authSubmitBtn.innerText = "Login";
        toggleAuthAction.innerText = "Don't have an account? Sign Up";
    } else {
        document.getElementById('authCardTitle').innerText = "Create Account";
        authSubmitBtn.innerText = "Register";
        toggleAuthAction.innerText = "Already have an account? Login";
    }
});

// Process Login / Account Creation Form Formats
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = authEmail.value;
    const password = authPassword.value;

    try {
        if (isLoginMode) {
            await signInWithEmailAndPassword(auth, email, password);
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
        }
        authForm.reset();
    } catch (error) {
        alert(error.message);
    }
});

// Handle Session Termination
logoutBtn.addEventListener('click', () => {
    signOut(auth).then(() => {
        if (activelyRingingAudio) {
            activelyRingingAudio.pause();
            activelyRingingAudio = null;
        }
    });
});

// Monitor Session Transitions Realtime
onAuthStateChanged(auth, (user) => {
    if (user) {
        // Logged In: Swap containers, open listener channels
        authSection.classList.add('d-none');
        mainAppSection.classList.remove('d-none');
        startRealTimeSync(user.uid);
    } else {
        // Logged Out: Reset views, kill active snapshot pipes
        authSection.classList.remove('d-none');
        mainAppSection.classList.add('d-none');
        
        if (unsubscribeSnapshot) {
            unsubscribeSnapshot(); 
        }
        taskList.innerHTML = "";
        localTasksArray = [];
    }
});

// ================= DATA PIPELINE MANAGEMENT =================

// 1. Submit Form to Firestore (Secured with userId tags)
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!auth.currentUser) return; // Prevent unauthorized writes

    const title = document.getElementById('taskTitle').value;
    const deadline = document.getElementById('taskDeadline').value;
    const offsetMinutes = parseInt(document.getElementById('taskOffset').value);
    const assignedTone = document.getElementById('taskTone').value;

    try {
        await addDoc(collection(db, "todos"), {
            userId: auth.currentUser.uid, // ADDED: Tag item to exact user id ownership
            title: title,
            deadline: deadline,
            offset: offsetMinutes, 
            tone: assignedTone,
            createdAt: new Date()
        });
        taskForm.reset(); 
    } catch (error) {
        console.error("Error saving task: ", error);
    }
});

// 2. Real-time Firebase Listener Filtered by User ID
function startRealTimeSync(uid) {
    // MODIFIED: Injected safety where query condition parameter 
    const q = query(
        collection(db, "todos"), 
        where("userId", "==", uid), 
        orderBy("deadline", "asc")
    );

    unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
        localTasksArray = []; 
        snapshot.forEach((snapshotDoc) => {
            localTasksArray.push({
                id: snapshotDoc.id,
                ...snapshotDoc.data()
            });
        });
        renderTasksRealTime();
    }, (error) => {
        console.error("Query listener subscription failure:", error);
    });
}

// 3. Render Loop View Engine
function renderTasksRealTime() {
    taskList.innerHTML = ""; 
    notificationArea.innerHTML = ""; 
    
    if (localTasksArray.length === 0) {
        taskList.innerHTML = `<li class="list-group-item text-center py-4 bg-transparent border-0 text-white-50">No plans listed yet. Add one above!</li>`;
        return;
    }

    localTasksArray.forEach((task) => {
        const now = new Date();
        const deadlineDate = new Date(task.deadline);
        
        const minutesOffset = task.offset || 0;
        const alarmTriggerDate = new Date(deadlineDate.getTime() - (minutesOffset * 60 * 1000));
        
        const timeDiff = alarmTriggerDate - now; 
        const minutesLeft = timeDiff / (1000 * 60);
        const daysLeft = timeDiff / (1000 * 60 * 60 * 24); 

        let badgeHTML = `<span class="badge bg-secondary px-3 py-2 rounded-pill">Scheduled</span>`;
        let cardBorderClass = "border-purple-accent"; 
        
        if (dismissedAlerts.has(task.id)) {
            badgeHTML = `<span class="badge bg-dark text-white-50 px-3 py-2 rounded-pill">Acknowledged</span>`;
            cardBorderClass = "border-secondary opacity-50";
        } else if (minutesLeft <= 0) {
            badgeHTML = `<span class="badge bg-danger px-3 py-2 rounded-pill">🚨 Alert Active</span>`;
            cardBorderClass = "border-danger border-2";

            if (!playedAlerts.has(task.id) && currentRingingTaskId !== task.id) {
                playedAlerts.add(task.id);
                currentRingingTaskId = task.id; 
                dismissAlarmBtn.setAttribute('data-active-id', task.id);
                
                const specificToneFile = task.tone || "beep.mp3";
                
                if (activelyRingingAudio) { 
                    try {
                        activelyRingingAudio.pause();
                        activelyRingingAudio.src = ""; 
                    } catch(e) {}
                }
                
                activelyRingingAudio = new Audio(specificToneFile);
                activelyRingingAudio.loop = true; 
                
                const playPromise = activelyRingingAudio.play();
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => console.log(`Playing audio track module: ${specificToneFile}`))
                        .catch(err => console.error("Audio engine failed to resolve automatically:", err));
                }
                
                const formattedDeadlineText = deadlineDate.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
                document.getElementById('alarmTaskTitle').innerText = task.title || "Untitled Plan";
                document.getElementById('alarmModalTime').innerText = `⚠️ Early warning reminder! Your absolute deadline is scheduled for: ${formattedDeadlineText}`;
                
                bootstrapAlarmModal.show();
                triggerSystemNotification(task.title);
            }
        } else if (minutesLeft > 0 && minutesLeft <= 60) {
            const minsRounded = Math.ceil(minutesLeft);
            badgeHTML = `<span class="badge bg-danger text-white px-3 py-2 rounded-pill fw-bold blink-animation">⏳ Alert in ${minsRounded} mins</span>`;
            cardBorderClass = "border-danger border-2";
            showBannerAlert(task.title);
        } else if (daysLeft > 0 && daysLeft <= 2) {
            badgeHTML = `<span class="badge bg-warning text-dark px-3 py-2 rounded-pill fw-bold">⚠️ Alert within 2 Days</span>`;
            cardBorderClass = "border-warning border-2"; 
            showBannerAlert(task.title);
        }

        const formattedDeadlineDate = deadlineDate.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
        let offsetLabel = "Exactly on time";
        if (minutesOffset === 5) offsetLabel = "5 mins early";
        if (minutesOffset === 60) offsetLabel = "1 hour early";
        if (minutesOffset === 1440) offsetLabel = "1 day early";

        const li = document.createElement('li');
        li.className = `list-group-item d-flex justify-content-between align-items-center py-3 mb-3 text-white rounded purple-card shadow-aesthetic border-start border-4 ${cardBorderClass}`;
        li.style.backgroundColor = "#1d0d30"; 
        li.innerHTML = `
            <div>
                <strong class="d-block h5 mb-1 text-white">${task.title || "Untitled Plan"}</strong>
                <small class="text-white-50">🚨 Actual Deadline: ${formattedDeadlineDate}</small>
                <div class="text-white-50 mt-1" style="font-size: 11px;">🎵 Tone: ${task.tone || "Beep"} | ⏰ Setup: Alert ${offsetLabel}</div>
            </div>
            <div class="d-flex align-items-center gap-3">
                ${badgeHTML}
                <button class="btn btn-outline-danger btn-sm rounded-circle delete-btn" data-id="${task.id}" style="width: 30px; height: 30px; padding: 0; line-height: 1;" title="Cancel Event">
                    ✕
                </button>
            </div>
        `;
        taskList.appendChild(li);
    });

    document.querySelectorAll('.delete-btn').forEach(button => {
        button.replaceWith(button.cloneNode(true));
    });

    document.querySelectorAll('.delete-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            itemPendingDeletion = e.target.getAttribute('data-id'); 
            bootstrapDeleteModal.show(); 
        });
    });
}

// 4. Heartbeat Sync Engine Checks
setInterval(() => {
    if (localTasksArray.length > 0) {
        renderTasksRealTime();
    }
}, 5000);

// Delete Confirmation Modal Click
confirmDeleteBtn.addEventListener('click', async () => {
    if (itemPendingDeletion) {
        try {
            await deleteDoc(doc(db, "todos", itemPendingDeletion));
            bootstrapDeleteModal.hide(); 
            itemPendingDeletion = null;
        } catch (error) {
            console.error("Error deleting item: ", error);
        }
    }
});

// Dismiss Audio Engine Trigger
dismissAlarmBtn.addEventListener('click', () => {
    if (activelyRingingAudio) {
        activelyRingingAudio.pause();
        activelyRingingAudio.currentTime = 0;
        activelyRingingAudio = null; 
    }
    
    const activeTaskId = dismissAlarmBtn.getAttribute('data-active-id');
    if (activeTaskId) {
        dismissedAlerts.add(activeTaskId);
    }
    
    currentRingingTaskId = null; 
    bootstrapAlarmModal.hide();
    renderTasksRealTime();
});

function showBannerAlert(title) {
    const alertDiv = document.createElement('div');
    alertDiv.className = "alert alert-warning alert-dismissible fade show mb-4 fw-bold shadow-lg";
    alertDiv.role = "alert";
    alertDiv.innerHTML = `
        📌 <strong>Upcoming Alert:</strong> The plan <strong>"${title}"</strong> tracking trigger closing in!
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    notificationArea.appendChild(alertDiv);
}

// Native Desktop Browser System Dispatch
function triggerSystemNotification(title) {
    if (Notification.permission === "granted") {
        new Notification("⏰ Early Alarm Reminder!", {
            body: `Your tracking alert for "${title}" has been triggered!`,
        });
    }
}