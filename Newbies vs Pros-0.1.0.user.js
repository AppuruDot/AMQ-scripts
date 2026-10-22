// ==UserScript==
// @name         Newbies vs Pros
// @namespace    https://github.com/klouie1092
// @version      0.1.0
// @description  Newbies vs Pros game mode for AMQ
// @author       Shinks
// @match        https://*.animemusicquiz.com/*
// @grant        none
// @require      https://github.com/joske2865/AMQ-Scripts/raw/master/common/amqScriptInfo.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=animemusicquiz.com
// ==/UserScript==

"use strict";

(function () {
    const MAX_LIVES = 20;
    const DEFAULT_LIVES = 10;
    const REQUIRED_PLAYERS = 6;
    const NEWBIE_TEAM = 1;
    const BLOCKER_TEAM = 2;
    const ATTACKER_TEAM = 3;
    const HEALER_TEAM = 4;
    const NEWBIE_DAMAGE = 3;
    const BLOCK_AMOUNT = 2;
    const ATTACKER_BASE_DAMAGE = 2;
    const HEAL_AMOUNT = 1;

    let nvpInProgress = false;
    let nvpState = null;

    if (typeof Listener === "undefined") return;

    // Wait for AMQ to finish loading.
    const loadInterval = setInterval(() => {
        if (document.querySelector("#loadingScreen.hidden")) {
            clearInterval(loadInterval);
            setup();
        }
    }, 500);

    function setup() {
        new Listener("game chat update", (data) => {
            if (!data || !Array.isArray(data.messages)) return;

            for (const message of data.messages) {
                if (!message || message.sender !== selfName) continue;

                if (
                    typeof message.message !== "string" ||
                    !/^\/nvp(?:\s|$)/i.test(message.message.trim())
                ) {
                    continue;
                }

                parseCommand(message.message);
            }
        }).bindListener();

        new Listener("answer results", (result) => {
            if (nvpInProgress) {
                processAnswerResults(result);
            }
        }).bindListener();

        console.log("[Newbies vs Pros] Listeners registered.");
    }

    function sendChatMessage(msg) {
        if (!socket?.sendCommand) {
            console.warn("[Newbies vs Pros] AMQ socket is unavailable.");
            return;
        }

        socket.sendCommand({
            type: "lobby",
            command: "game chat message",
            data: {
                msg,
                teamMessage: false
            }
        });
    }

    function getPlayers() {
        if (typeof quiz === "undefined" || !quiz?.players) return [];
        return Object.values(quiz.players);
    }

    function parseCommand(input) {
        const parts = input.trim().split(/\s+/);
        const args = parts.slice(1);

        if (args[0]?.toLowerCase() === "stop") {
            if (nvpInProgress) {
                stopNvpGame("Newbies vs Pros stopped.");
            } else {
                sendChatMessage("No Newbies vs Pros game is currently running.");
            }
            return;
        }

        if (args.length > 1) {
            sendChatMessage("Usage: /nvp [number of lives] or /nvp stop");
            return;
        }

        const initialLives = args.length === 0
            ? DEFAULT_LIVES
            : Number(args[0]);

        if (!Number.isInteger(initialLives) || initialLives <= 0) {
            sendChatMessage("Please enter a positive whole number of lives.");
            return;
        }

        if (initialLives > MAX_LIVES) {
            sendChatMessage(`Lives cannot be higher than ${MAX_LIVES}.`);
            return;
        }

        if (nvpInProgress) {
            sendChatMessage("Newbies vs Pros is already in progress.");
            return;
        }

        if (typeof quiz === "undefined" || !quiz?.players) {
            sendChatMessage("Unable to read the current lobby players.");
            return;
        }

        const players = getPlayers();

        if (players.length !== REQUIRED_PLAYERS) {
            sendChatMessage(
                `Newbies vs Pros requires exactly ${REQUIRED_PLAYERS} players (3 newbies in Team ${NEWBIE_TEAM}, pros in Teams ${BLOCKER_TEAM}, ${ATTACKER_TEAM} and ${HEALER_TEAM}).`
            );
            return;
        }

        const newbies = players.filter(p => Number(p.teamNumber) === NEWBIE_TEAM);
        const blocker = players.filter(p => Number(p.teamNumber) === BLOCKER_TEAM);
        const attacker = players.filter(p => Number(p.teamNumber) === ATTACKER_TEAM);
        const healer = players.filter(p => Number(p.teamNumber) === HEALER_TEAM);

        if (
            newbies.length !== 3 ||
            blocker.length !== 1 ||
            attacker.length !== 1 ||
            healer.length !== 1
        ) {
            sendChatMessage(
                `Invalid teams. Need 3 players in Team ${NEWBIE_TEAM} and 1 player each in Teams ${BLOCKER_TEAM}, ${ATTACKER_TEAM} and ${HEALER_TEAM}.`
            );
            return;
        }

        nvpState = {
            newbies: newbies.map(p => ({ id: p.gamePlayerId, name: p.name })),
            blocker: { id: blocker[0].gamePlayerId, name: blocker[0].name },
            attacker: { id: attacker[0].gamePlayerId, name: attacker[0].name },
            healer: { id: healer[0].gamePlayerId, name: healer[0].name },
            newbieLives: initialLives,
            proLives: initialLives,
            attackerStack: 0
        };

        nvpInProgress = true;

        sendChatMessage(
            `Newbies vs Pros started with ${initialLives} lives per team!`
        );
        sendChatMessage(
            `Newbies: ${nvpState.newbies.map(p => p.name).join(", ")}`
        );
        sendChatMessage(`Blocker: ${nvpState.blocker.name}`);
        sendChatMessage(`Attacker: ${nvpState.attacker.name}`);
        sendChatMessage(`Healer: ${nvpState.healer.name}`);

        sendNvpScore();
    }

    function processAnswerResults(result) {
        if (!nvpInProgress || !nvpState) return;

        const currentIds = new Set(getPlayers().map(p => p.gamePlayerId));
        const rosterIds = [
            ...nvpState.newbies.map(p => p.id),
            nvpState.blocker.id,
            nvpState.attacker.id,
            nvpState.healer.id
        ];

        if (rosterIds.some(id => !currentIds.has(id))) {
            stopNvpGame("A player left. Newbies vs Pros stopped.");
            return;
        }

        const resultsByPlayer = new Map();

        for (const playerResult of result.players || []) {
            resultsByPlayer.set(
                playerResult.gamePlayerId,
                playerResult.correct === true
            );
        }

        const isCorrect = id => resultsByPlayer.get(id) === true;

        // The newbies share one answer, so any flagged correct counts for the team.
        const newbiesCorrect = nvpState.newbies.some(p => isCorrect(p.id));
        const blockerCorrect = isCorrect(nvpState.blocker.id);
        const attackerCorrect = isCorrect(nvpState.attacker.id);
        const healerCorrect = isCorrect(nvpState.healer.id);

        // Everyone correct: no changes to lives or the attacker's stack.
        if (newbiesCorrect && blockerCorrect && attackerCorrect && healerCorrect) {
            sendChatMessage("Everyone got the song right! No changes.");
            sendNvpScore();
            return;
        }

        // Healer heals the Pros by 1 (cap 20). Applied before damage.
        if (healerCorrect && nvpState.proLives < MAX_LIVES) {
            nvpState.proLives = Math.min(
                MAX_LIVES,
                nvpState.proLives + HEAL_AMOUNT
            );
            sendChatMessage(
                `${nvpState.healer.name} (Healer) healed the Pros by ${HEAL_AMOUNT} life!`
            );
        }

        let damageToPros = 0;
        let damageToNewbies = 0;

        // Newbies attack the Pros; the Blocker reduces it by 2 if also correct.
        if (newbiesCorrect) {
            if (blockerCorrect) {
                damageToPros = Math.max(0, NEWBIE_DAMAGE - BLOCK_AMOUNT);
                sendChatMessage(
                    `${nvpState.blocker.name} (Blocker) blocked ${BLOCK_AMOUNT} damage! The Newbies dealt ${damageToPros} damage to the Pros.`
                );
            } else {
                damageToPros = NEWBIE_DAMAGE;
                sendChatMessage(
                    `The Newbies dealt ${NEWBIE_DAMAGE} damage to the Pros!`
                );
            }
        }

        // Attacker logic.
        if (attackerCorrect) {
            if (newbiesCorrect) {
                nvpState.attackerStack += 1;
                sendChatMessage(
                    `${nvpState.attacker.name} (Attacker) stacked up! Next attack bonus: +${nvpState.attackerStack}`
                );
            } else {
                damageToNewbies = ATTACKER_BASE_DAMAGE + nvpState.attackerStack;
                sendChatMessage(
                    nvpState.attackerStack > 0
                        ? `${nvpState.attacker.name} (Attacker) dealt ${damageToNewbies} damage to the Newbies! (${ATTACKER_BASE_DAMAGE} + ${nvpState.attackerStack} bonus)`
                        : `${nvpState.attacker.name} (Attacker) dealt ${damageToNewbies} damage to the Newbies!`
                );
                nvpState.attackerStack = 0;
            }
        } else if (nvpState.attackerStack > 0) {
            nvpState.attackerStack -= 1;
            sendChatMessage(
                `${nvpState.attacker.name} (Attacker) missed. Bonus reduced to +${nvpState.attackerStack}`
            );
        }

        // Apply damage after healing and attack calculations.
        nvpState.proLives = Math.max(0, nvpState.proLives - damageToPros);
        nvpState.newbieLives = Math.max(0, nvpState.newbieLives - damageToNewbies);

        sendNvpScore();

        // Determine the winner after all effects have been applied.
        if (nvpState.newbieLives <= 0 && nvpState.proLives <= 0) {
            stopNvpGame("Newbies vs Pros ended in a draw!");
        } else if (nvpState.newbieLives <= 0) {
            stopNvpGame("Newbies vs Pros completed! The Pros win!");
        } else if (nvpState.proLives <= 0) {
            stopNvpGame("Newbies vs Pros completed! The Newbies win!");
        }
    }

    function sendNvpScore() {
        if (!nvpState) return;

        sendChatMessage(
            `Newbies vs Pros: ${nvpState.newbieLives}-${nvpState.proLives} | Attacker bonus: +${nvpState.attackerStack}`
        );
    }

    function stopNvpGame(message) {
        nvpInProgress = false;
        nvpState = null;
        sendChatMessage(message);
    }
})();